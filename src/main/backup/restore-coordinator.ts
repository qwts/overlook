import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { addAbortSignal, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { openRecoveryKey, RecoveryError } from '../crypto/recovery.js';
import { createDecryptStream } from '../crypto/envelope.js';
import { discoverRestore, type RestoreCandidate, type RestoreDiscovery } from './restore-discovery.js';
import type { RestoreRequest, RestoreRunResult, RestoreVerifyResult } from './restore-engine.js';
import type { StorageProvider } from './provider.js';
import { healRemoteGaps } from './restore-heal.js';
import { RestoreError, toRestoreError, type RestoreProgress } from './restore-types.js';
import type {
  RestoreDiscoverResponse,
  RestoreLibrarySummary,
  RestoreRunResponse,
  RestoreStatusSnapshot,
  RestoreTrashResponse,
  RestoreVerifyResponse,
} from '../../shared/backup/restore-contract.js';

export interface RestoreSource {
  readonly libraryId: string;
  readonly provider: StorageProvider;
}

interface DiscoveredSource extends RestoreSource {
  readonly discovery: RestoreDiscovery;
}

interface RestoreSession {
  readonly id: string;
  readonly providerId: string;
  readonly masterKey: Buffer;
  readonly custodyPassword: string | null;
  readonly sources: ReadonlyMap<string, DiscoveredSource>;
  readonly verifications: Map<string, RestoreVerifyResult>;
}

export interface RestoreRunner {
  run(request: RestoreRequest): Promise<RestoreRunResult>;
  verify?(request: RestoreRequest): Promise<RestoreVerifyResult>;
}

/** How discovery obtains the master key (#741 follow-up): the separately
 * saved recovery-key file, or this machine's own keystore — a library whose
 * keystore is open already holds the very key its cloud backups were sealed
 * under, and demanding the exported file there makes the backup unrestorable
 * for no security gain (the key is ALREADY resident). */
export type RestoreKeySource =
  | { readonly kind: 'recovery-key'; readonly path: string; readonly password: string }
  /** custodyPassword (#754): the app password the facade just verified as
   * fresh authority. It rides the session so activation can re-establish
   * password-derived custody for the restored library. */
  | { readonly kind: 'local-master'; readonly custodyPassword?: string | undefined };

export interface RestoreCoordinatorDeps {
  readonly readRecoveryKey: (path: string) => Promise<Buffer>;
  /** A COPY of the open library's master key, or null when no keystore is
   * available (fresh profile, locked library). Callers own the copy. */
  readonly localMasterKey?: (() => Buffer | null) | undefined;
  readonly sources: (providerId: string) => Promise<readonly RestoreSource[]>;
  readonly createRunner: (provider: StorageProvider, progress: (value: RestoreProgress) => void) => RestoreRunner;
  readonly sessionId: () => string;
  readonly resumeAvailable?: ((libraryId: string, candidate: RestoreCandidate) => Promise<boolean>) | undefined;
  readonly progress: (value: RestoreProgress) => void;
  readonly statusChanged?: ((status: RestoreStatusSnapshot) => void) | undefined;
  readonly workStarted?: (() => void) | undefined;
  readonly workFinished?: (() => void) | undefined;
  readonly activated?: ((result: RestoreRunResult) => void) | undefined;
}

type FailurePhase = 'discovering' | 'downloading' | 'rebuilding' | 'activating' | 'verify-scan';

function errorResult(error: unknown, phase?: FailurePhase): { reason: RestoreError['reason']; message: string; phase?: FailurePhase } {
  if (error instanceof RecoveryError) {
    return {
      reason: error.reason === 'wrong-password' ? 'wrong-key' : 'corrupt',
      message: error.reason === 'wrong-password' ? 'The recovery-key password is incorrect.' : 'This is not an Overlook recovery key.',
      ...(phase === undefined ? {} : { phase }),
    };
  }
  const mapped = toRestoreError(error);
  return { reason: mapped.reason, message: mapped.message, ...(phase === undefined ? {} : { phase }) };
}

function invalidSummary(libraryId: string, error: RestoreError): RestoreLibrarySummary {
  const validation = error.reason === 'wrong-key' ? 'wrong-key' : error.reason === 'unsupported' ? 'unsupported' : 'corrupt';
  return {
    libraryId,
    generation: null,
    generatedAt: null,
    photos: null,
    totalBytes: null,
    albums: null,
    compatibility: error.reason === 'unsupported' ? 'unsupported' : 'unknown',
    validation,
    fallbackGenerations: 0,
    resumable: false,
  };
}

function verificationMatches(left: RestoreVerifyResult, right: RestoreVerifyResult): boolean {
  return (
    left.libraryId === right.libraryId &&
    left.generation === right.generation &&
    left.manifestPath === right.manifestPath &&
    left.sealedManifestSha256 === right.sealedManifestSha256 &&
    left.objectSetSha256 === right.objectSetSha256 &&
    isDeepStrictEqual(left.missing, right.missing)
  );
}

export class RestoreCoordinator {
  private session: RestoreSession | null = null;
  private controller: AbortController | null = null;
  private readonly active = new Set<Promise<unknown>>();
  private phase: RestoreStatusSnapshot['phase'] = 'idle';
  private lastProgress: RestoreProgress | null = null;
  private lastError: RestoreStatusSnapshot['lastError'] = null;
  private lastResult: RestoreStatusSnapshot['lastResult'] = null;
  private lastLibraries: readonly RestoreLibrarySummary[] = [];
  private lastLibraryId: string | null = null;

  constructor(private readonly deps: RestoreCoordinatorDeps) {}

  private clearSession(): void {
    this.session?.masterKey.fill(0);
    this.session = null;
  }

  private emitStatus(): void {
    this.deps.statusChanged?.(this.status());
  }

  private setPhase(phase: RestoreStatusSnapshot['phase']): void {
    this.phase = phase;
    this.emitStatus();
  }

  private recordProgress(progress: RestoreProgress): void {
    this.lastProgress = progress;
    this.deps.progress(progress);
    this.emitStatus();
  }

  status(): RestoreStatusSnapshot {
    const session = this.session;
    const verificationEntry = session === null ? undefined : [...session.verifications.entries()][0];
    const verification = verificationEntry?.[1];
    const singleSource = session !== null && session.sources.size === 1 ? [...session.sources.keys()][0] : undefined;
    return {
      phase: this.phase,
      sessionId: session?.id ?? null,
      libraryId: this.lastLibraryId ?? singleSource ?? null,
      providerId: session?.providerId ?? null,
      progress: this.lastProgress,
      lastError: this.lastError,
      lastResult: this.lastResult,
      verification:
        verificationEntry === undefined || verification === undefined
          ? null
          : {
              verificationId: verificationEntry[0],
              libraryId: verification.libraryId,
              generation: verification.generation,
              photos: verification.photos,
              verifiedCount: verification.verifiedCount,
              missingCount: verification.missingCount,
              corruptCount: verification.corruptCount,
              missing: [...verification.missing],
            },
      libraries: this.lastLibraries,
    };
  }

  discover(providerId: string, keyPath: string, password: string): Promise<RestoreDiscoverResponse> {
    return this.discoverFrom(providerId, { kind: 'recovery-key', path: keyPath, password });
  }

  /** Drops the discovered session (#757 review): a refused local-key
   * authorization must not leave a prior session's master key runnable.
   * An active run owns the session key, so it is left untouched — the same
   * rule discovery itself follows. */
  expireSession(): void {
    if (this.controller !== null) return;
    this.clearSession();
    if (this.phase === 'session' || this.phase === 'failed') this.setPhase('idle');
  }

  discoverFrom(providerId: string, source: RestoreKeySource): Promise<RestoreDiscoverResponse> {
    return this.track(() => this.discoverOperation(providerId, source));
  }

  private async openMasterKey(source: RestoreKeySource): Promise<Buffer> {
    if (source.kind === 'recovery-key') {
      return openRecoveryKey(await this.deps.readRecoveryKey(source.path), source.password);
    }
    const local = this.deps.localMasterKey?.() ?? null;
    if (local === null) {
      throw new RestoreError('wrong-key', "This Mac's stored key is unavailable. Use the recovery key exported for this library.");
    }
    return local;
  }

  private async discoverOperation(providerId: string, source: RestoreKeySource): Promise<RestoreDiscoverResponse> {
    if (this.controller !== null) {
      return { sessionId: null, libraries: [], error: { reason: 'io', message: 'A restore is already running.' } };
    }
    this.clearSession();
    this.lastError = null;
    this.lastResult = null;
    this.lastProgress = null;
    this.lastLibraries = [];
    this.lastLibraryId = null;
    this.setPhase('idle');
    let masterKey: Buffer;
    try {
      masterKey = await this.openMasterKey(source);
    } catch (error) {
      return { sessionId: null, libraries: [], error: errorResult(error) };
    }

    try {
      const sources = await this.deps.sources(providerId);
      if (sources.length === 0) {
        masterKey.fill(0);
        return { sessionId: null, libraries: [], error: { reason: 'corrupt', message: 'No Overlook cloud libraries were found.' } };
      }
      const valid = new Map<string, DiscoveredSource>();
      const libraries: RestoreLibrarySummary[] = [];
      for (const source of sources) {
        try {
          const discovery = await discoverRestore(source.provider, masterKey);
          const candidate = discovery.candidates[0];
          if (candidate === undefined) throw new RestoreError('corrupt', 'No valid restore generation was found.');
          const discoveredLibraryId = discovery.bootstrap.libraryId;
          valid.set(discoveredLibraryId, { ...source, libraryId: discoveredLibraryId, discovery });
          libraries.push({
            libraryId: discoveredLibraryId,
            generation: candidate.generation,
            generatedAt: candidate.manifest.generatedAt,
            photos: candidate.manifest.totals.photos,
            totalBytes: candidate.manifest.totals.bytes,
            albums: candidate.manifest.totals.albums,
            compatibility: 'compatible',
            validation: 'valid',
            fallbackGenerations: Math.max(0, discovery.candidates.length - 1),
            resumable: (await this.deps.resumeAvailable?.(discoveredLibraryId, candidate)) ?? false,
          });
          // A recovered master key belongs to one library. Returning as soon
          // as it authenticates a bootstrap prevents unrelated stale iCloud
          // homes from delaying or blocking the matching restore (#751).
          break;
        } catch (error) {
          const mapped = toRestoreError(error);
          if (mapped.reason === 'auth' || mapped.reason === 'offline' || mapped.reason === 'cancelled') throw mapped;
          libraries.push(invalidSummary(source.libraryId, mapped));
        }
      }
      const id = this.deps.sessionId();
      const custodyPassword = source.kind === 'local-master' ? (source.custodyPassword ?? null) : null;
      this.session = { id, providerId, masterKey, custodyPassword, sources: valid, verifications: new Map() };
      this.lastLibraries = libraries;
      this.lastLibraryId = libraries.find((library) => library.validation === 'valid')?.libraryId ?? null;
      this.setPhase('session');
      return { sessionId: id, libraries, error: null };
    } catch (error) {
      masterKey.fill(0);
      return { sessionId: null, libraries: [], error: errorResult(error) };
    }
  }

  run(sessionId: string, libraryId: string, verificationId: string, allowReplace: boolean): Promise<RestoreRunResponse> {
    return this.track(() => this.runOperation(sessionId, libraryId, verificationId, allowReplace));
  }

  verify(sessionId: string, libraryId: string): Promise<RestoreVerifyResponse> {
    return this.track(() => this.verifyOperation(sessionId, libraryId));
  }

  trash(sessionId: string, libraryId: string, verificationId: string, confirmation: string): Promise<RestoreTrashResponse> {
    return this.track(() => this.trashOperation(sessionId, libraryId, verificationId, confirmation));
  }

  private async runOperation(
    sessionId: string,
    libraryId: string,
    verificationId: string,
    allowReplace: boolean,
  ): Promise<RestoreRunResponse> {
    const session = this.session;
    const source = session?.sources.get(libraryId);
    if (session === null || session.id !== sessionId || source === undefined) {
      return { result: null, error: { reason: 'io', message: 'Restore discovery expired; discover the backup again.' } };
    }
    if (this.controller !== null) {
      return { result: null, error: { reason: 'io', message: 'A restore is already running.' } };
    }
    const verification = session.verifications.get(verificationId);
    if (verification === undefined || verification.libraryId !== libraryId) {
      return { result: null, error: { reason: 'io', message: 'Restore verification expired; verify the backup again.' } };
    }
    session.verifications.delete(verificationId);
    const controller = new AbortController();
    this.controller = controller;
    this.lastLibraryId = libraryId;
    this.lastError = null;
    this.lastResult = null;
    this.setPhase('running');
    this.deps.workStarted?.();
    let failurePhase: FailurePhase = 'discovering';
    try {
      const expectedGeneration = source.discovery.newestGeneration;
      const runner = this.deps.createRunner(source.provider, (progress) => {
        if (progress.stage !== 'complete') failurePhase = progress.stage === 'verifying' ? 'discovering' : progress.stage;
        this.recordProgress(progress);
      });
      const result = await runner.run({
        masterKey: session.masterKey,
        allowReplace,
        signal: controller.signal,
        verification,
        ...(session.custodyPassword === null ? {} : { custodyPassword: session.custodyPassword }),
      });
      if (result.missing.length > 0) {
        try {
          await healRemoteGaps(source.provider, result.generation, result.missing);
        } catch (error) {
          console.error(
            `[overlook] heal could not move remote gaps after restore: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      this.deps.activated?.(result);
      this.lastResult = {
        libraryId: result.libraryId,
        generation: result.generation,
        photos: result.photos,
        resumed: result.resumed,
        missing: result.missing,
      };
      this.clearSession();
      this.setPhase('complete');
      return {
        result: {
          ...result,
          fallbackFromGeneration: expectedGeneration !== result.generation ? expectedGeneration : null,
          relaunching: false,
        },
        error: null,
      };
    } catch (error) {
      const mapped = errorResult(error, failurePhase);
      this.lastError = mapped;
      this.setPhase('failed');
      return { result: null, error: mapped };
    } finally {
      this.controller = null;
      this.deps.workFinished?.();
    }
  }

  private async verifyOperation(sessionId: string, libraryId: string): Promise<RestoreVerifyResponse> {
    const session = this.session;
    const source = session?.sources.get(libraryId);
    if (session === null || session.id !== sessionId || source === undefined) {
      return { result: null, error: { reason: 'io', message: 'Restore discovery expired; discover the backup again.' } };
    }
    if (this.controller !== null) {
      return { result: null, error: { reason: 'io', message: 'A restore is already running.' } };
    }
    const controller = new AbortController();
    this.controller = controller;
    this.lastLibraryId = libraryId;
    this.lastError = null;
    this.setPhase('verify-scan');
    this.deps.workStarted?.();
    try {
      const runner = this.deps.createRunner(source.provider, (progress) => {
        this.recordProgress(progress);
      });
      if (runner.verify === undefined) {
        this.setPhase('session');
        return { result: null, error: { reason: 'io', message: 'Verify is not available in this runner.' } };
      }
      const result = await runner.verify({
        masterKey: session.masterKey,
        allowReplace: false,
        signal: controller.signal,
        ...(session.custodyPassword === null ? {} : { custodyPassword: session.custodyPassword }),
      });
      const verificationId = randomUUID();
      session.verifications.clear();
      session.verifications.set(verificationId, result);
      this.setPhase('session');
      return {
        result: {
          verificationId,
          libraryId: result.libraryId,
          generation: result.generation,
          photos: result.photos,
          verifiedCount: result.verifiedCount,
          missingCount: result.missingCount,
          corruptCount: result.corruptCount,
          missing: [...result.missing],
        },
        error: null,
      };
    } catch (error) {
      const mapped = errorResult(error, 'verify-scan');
      this.lastError = mapped;
      this.setPhase('failed');
      return { result: null, error: mapped };
    } finally {
      this.controller = null;
      this.deps.workFinished?.();
    }
  }

  private async trashOperation(
    sessionId: string,
    libraryId: string,
    verificationId: string,
    confirmation: string,
  ): Promise<RestoreTrashResponse> {
    if (confirmation !== 'Permanently Delete Backup') {
      return { trashed: false, error: { reason: 'io', message: 'Confirmation text does not match.' } };
    }
    const session = this.session;
    const source = session?.sources.get(libraryId);
    if (session === null || session.id !== sessionId || source === undefined) {
      return { trashed: false, error: { reason: 'io', message: 'Restore discovery expired; discover the backup again.' } };
    }
    const verification = session.verifications.get(verificationId);
    if (verification === undefined || verification.libraryId !== libraryId) {
      return { trashed: false, error: { reason: 'io', message: 'Restore verification expired; verify the backup again.' } };
    }
    session.verifications.delete(verificationId);
    try {
      const entries = await source.provider.list('.', undefined);
      for (const entry of entries) {
        await source.provider.delete(entry.path);
      }
      const remaining = await source.provider.list('.', undefined);
      if (remaining.length > 0) {
        return {
          trashed: false,
          error: { reason: 'io', message: `Backup trash is incomplete; ${String(remaining.length)} objects remain.` },
        };
      }
      this.clearSession();
      return { trashed: true, error: null };
    } catch (error) {
      return { trashed: false, error: errorResult(error) };
    }
  }

  providerFor(sessionId: string, libraryId: string): StorageProvider | null {
    const session = this.session;
    if (session === null || session.id !== sessionId) return null;
    return session.sources.get(libraryId)?.provider ?? null;
  }

  verificationFor(sessionId: string, libraryId: string, verificationId: string): RestoreVerifyResult | null {
    const session = this.session;
    if (session === null || session.id !== sessionId) return null;
    const verification = session.verifications.get(verificationId);
    return verification?.libraryId === libraryId ? verification : null;
  }

  exportCorrupt(
    sessionId: string,
    libraryId: string,
    verificationId: string,
    writeImage: (fileName: string, bytes: Buffer) => Promise<void>,
  ): Promise<{ exported: boolean; count: number; unavailable: number; error: string | null }> {
    return this.track(async () => {
      const session = this.session;
      const source = session?.sources.get(libraryId);
      const verification = this.verificationFor(sessionId, libraryId, verificationId);
      if (session === null || source === undefined || verification === null) {
        return { exported: false, count: 0, unavailable: 0, error: 'Restore verification expired; verify the backup again.' };
      }
      if (this.controller !== null) {
        return { exported: false, count: 0, unavailable: 0, error: 'A restore is already running.' };
      }
      const candidate = source.discovery.candidates.find(
        (item) =>
          item.path === verification.manifestPath &&
          item.generation === verification.generation &&
          item.sealedSha256 === verification.sealedManifestSha256,
      );
      if (candidate === undefined) {
        return { exported: false, count: 0, unavailable: 0, error: 'Restore verification expired; verify the backup again.' };
      }
      const corrupt = verification.missing.filter((item) => item.reason === 'failed-verification');
      const controller = new AbortController();
      this.controller = controller;
      this.deps.workStarted?.();
      let count = 0;
      let unavailable = 0;
      try {
        const runner = this.deps.createRunner(source.provider, this.deps.progress);
        if (runner.verify === undefined) {
          return { exported: false, count: 0, unavailable: 0, error: 'Verify is not available in this runner.' };
        }
        const current = await runner.verify({
          masterKey: session.masterKey,
          allowReplace: false,
          signal: controller.signal,
          ...(session.custodyPassword === null ? {} : { custodyPassword: session.custodyPassword }),
        });
        if (!verificationMatches(current, verification)) {
          session.verifications.delete(verificationId);
          return { exported: false, count: 0, unavailable: 0, error: 'The backup changed after verification. Verify it again.' };
        }
        for (const item of corrupt) {
          const photo = item.kind === 'original' ? candidate.manifest.photos.find((entry) => entry.id === item.photoId) : undefined;
          if (photo === undefined) {
            unavailable += 1;
            continue;
          }
          try {
            const remote = addAbortSignal(controller.signal, await source.provider.getStream(item.path));
            const ciphertext = await buffer(remote);
            const plaintext = await buffer(
              Readable.from([ciphertext]).pipe(createDecryptStream(source.discovery.resolveKey, { photoId: photo.id })),
            );
            if (createHash('sha256').update(plaintext).digest('hex') === photo.contentHash) {
              plaintext.fill(0);
              unavailable += 1;
              continue;
            }
            try {
              await writeImage(`${photo.id}-${photo.fileName}`, plaintext);
            } finally {
              plaintext.fill(0);
            }
            count += 1;
          } catch {
            if (controller.signal.aborted) throw new RestoreError('cancelled', 'restore cancelled');
            unavailable += 1;
          }
        }
        return {
          exported: unavailable === 0,
          count,
          unavailable,
          error:
            unavailable === 0
              ? null
              : `${String(count)} decryptable images exported; ${String(unavailable)} corrupt objects were unavailable.`,
        };
      } catch (error) {
        return { exported: false, count, unavailable, error: errorResult(error).message };
      } finally {
        this.controller = null;
        this.deps.workFinished?.();
      }
    });
  }

  /** Do nothing after verify: drop the plan, keep discovery. A live
   * verify/restore owns the session and is left untouched. */
  dismissVerification(): void {
    if (this.controller !== null || this.session === null) return;
    this.session.verifications.clear();
    this.emitStatus();
  }

  cancel(): void {
    this.controller?.abort();
  }

  dispose(): void {
    this.cancel();
    this.clearSession();
    this.setPhase('idle');
  }

  async close(): Promise<void> {
    this.cancel();
    await Promise.allSettled([...this.active]);
    this.clearSession();
    this.setPhase('idle');
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    const active = operation();
    this.active.add(active);
    const remove = () => this.active.delete(active);
    void active.then(remove, remove);
    return active;
  }
}
