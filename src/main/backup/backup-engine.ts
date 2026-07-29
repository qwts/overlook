import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ProviderError, type StorageProvider } from './provider.js';
import type { SyncLedger } from './sync-ledger.js';
import {
  buildBackupManifestV5,
  type BackupManifestBoardV5,
  type BackupManifestSnapshot,
  type BackupManifestSnapshotV5,
  type ProtectedBackupAlbumV3,
  type ProtectedBackupPhotoV3,
} from './backup-manifest.js';
import type { SyncStatus } from '../../shared/library/types.js';
import type { BackupIntegritySummary } from './integrity-scrubber.js';
import type { ActivityEvent } from '../../shared/activity/types.js';

// Backup engine (#105, ADR-0007): dirty photos flow to the provider
// reliably and politely. The ledger's dirty set IS the queue and the resume
// state — a relaunch simply runs again and picks up whatever is still
// dirty. Blobs upload as local ciphertext, byte-for-byte (encrypt-once);
// each batch seals and uploads a manifest generation. Per-item transient
// failures retry with exponential backoff; auth/quota failures stop the run
// (retrying cannot help). Verification tightens the synced bit in #106.
// Publication is preflight-gated (#741): a generation never seals a
// reference to an object the selected provider does not hold.

export interface BackupSettings {
  /** 10–100, or null = unlimited (M09's slider). */
  readonly throttlePercent: number | null;
  readonly wifiOnly: boolean;
  readonly autoBackupOnImport: boolean;
}

export type NetworkKind = 'wifi' | 'other' | 'unknown';

export interface BackupItemPhoto {
  readonly id: string;
  readonly contentHash: string;
  readonly bytes: number;
  readonly fileName: string;
  readonly keyId: number;
}

export interface DirtyBackupPhoto extends BackupItemPhoto {
  /** Ledger status fetched by the dirty query itself — re-querying it per
   * item cost 2 statements × 94K rows before the first upload (the 113K-
   * import freeze). */
  readonly status: SyncStatus;
}

export interface OrdinaryRemoteClaim extends BackupItemPhoto {
  readonly status: 'synced' | 'offloaded';
  readonly deleted: boolean;
}

export interface BackupRunResult {
  readonly uploaded: number;
  readonly failed: number;
  /** False when blobs landed but the manifest generation did not — the
   * next run retries it even with nothing dirty (PR #203 review). */
  readonly manifestUploaded: boolean;
  /** 'wifi' when the gate skipped the run entirely. */
  readonly skipped: 'wifi' | null;
  readonly integrity: BackupRunIntegrity;
  /** Manifest-referenced remote-only objects the selected provider does not
   * hold and no local original can supply (#741) — claims whose verified
   * copy lives on a different provider. The run fails closed: nothing
   * publishes until the objects exist here or the selection changes back. */
  readonly blockedRemoteOnly: number;
}

export interface BackupRunIntegrity {
  readonly checked: number;
  readonly repaired: number;
  readonly unrecoverable: number;
  readonly recoveryRepaired: boolean;
  readonly failed: boolean;
}

export interface BackupEngineDeps {
  readonly provider: StorageProvider;
  readonly ledger: SyncLedger;
  readonly dirtyPhotos: () => readonly DirtyBackupPhoto[];
  /** RAW ciphertext for `contentHash` — uploaded as-is. */
  readonly encryptedStream: (contentHash: string) => Readable;
  /** Seals the manifest JSON (envelope, current key) → ciphertext bytes. */
  readonly sealManifest: (json: string) => Promise<Buffer>;
  /** Seals wrapped key records for fresh-machine recovery under the master. */
  readonly sealRecoveryBootstrap: (generatedAt: string) => Buffer;
  readonly libraryId: () => string;
  /** One consistent DB snapshot: photos, metadata, albums, and membership. */
  readonly manifestSnapshot: () => BackupManifestSnapshot;
  readonly activitySnapshot?: (() => readonly ActivityEvent[]) | undefined;
  readonly boardsSnapshot?: (() => readonly BackupManifestBoardV5[]) | undefined;
  readonly settings: () => BackupSettings;
  readonly network: () => NetworkKind;
  readonly events: {
    progress(done: number, total: number, photoId: string | null): void;
  };
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pendingCountChanged: (count: number) => void;
  /** Status changes patch loaded tiles without invalidating the gallery. */
  readonly syncStateChanged: (updates: readonly { readonly id: string; readonly syncState: SyncStatus }[]) => void;
  /** Verify results append to M11's audit trail (#106). */
  readonly audit: (line: string) => void;
  readonly integrityScrub: () => Promise<BackupIntegritySummary>;
  readonly recoveryGenerationHealthy: () => Promise<boolean>;
  /** Maps a preflight's missing blob hashes back to the rows that promise
   * them (#741) so locally available originals re-queue and upload. */
  readonly claimsForContentHashes?: ((hashes: readonly string[]) => readonly OrdinaryRemoteClaim[]) | undefined;
  readonly hasLocalOriginal?: ((contentHash: string) => boolean) | undefined;
  /** Durable manifest debt (#741): survives restart so an owed generation is
   * never forgotten between runs. */
  readonly manifestDebt?: { readonly load: () => boolean; readonly save: (owed: boolean) => void } | undefined;
  readonly protectedBackup?: {
    readonly run: (signal?: AbortSignal) => Promise<{ readonly uploaded: number; readonly failed: number }>;
    readonly scrub: () => Promise<BackupIntegritySummary>;
    readonly hasManifestDebt: () => boolean;
    /** Preflight reconciliation for missing protected paths (#741): local
     * ciphertext re-queues; remote-only objects are blocked. */
    readonly reconcileMissing?: ((paths: readonly string[]) => { readonly requeued: number; readonly blocked: number }) | undefined;
    readonly snapshot: () => {
      readonly protectedAlbums: readonly ProtectedBackupAlbumV3[];
      readonly protectedPhotos: readonly ProtectedBackupPhotoV3[];
    };
    readonly settleManifest: (snapshot: {
      readonly protectedAlbums: readonly ProtectedBackupAlbumV3[];
      readonly protectedPhotos: readonly ProtectedBackupPhotoV3[];
    }) => void;
  };
}

/** Publication preflight failed (#741): the manifest references objects the
 * selected provider does not hold. Never a transport error — the generation
 * simply must not exist. */
export class ManifestIncompleteError extends Error {
  override readonly name = 'ManifestIncompleteError';

  constructor(readonly missing: readonly string[]) {
    super(`manifest references ${String(missing.length)} objects missing from the selected provider`);
  }
}

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
/** Circuit breaker: this many consecutive transient item failures means the
 * network (or provider) is down for everyone — abort the sweep instead of
 * burning 3 attempts + backoff + a ledger error write on every remaining
 * dirty row (~94K at the 113K-import freeze). Dirty rows resume next run. */
const TRANSIENT_FAILURE_BREAK = 10;
/** Manifest generations retained remotely (ADR-0007). */
const MANIFEST_KEEP = 2;
const EMPTY_INTEGRITY: BackupRunIntegrity = {
  checked: 0,
  repaired: 0,
  unrecoverable: 0,
  recoveryRepaired: false,
  failed: false,
};

function blobPath(contentHash: string): string {
  return `blobs/${contentHash.slice(0, 2)}/${contentHash}`;
}

/** Remote presence knowledge for the publication preflight (#741): one
 * listing per provider per prefix per engine lifetime, extended by this
 * process's own verified uploads. Continuous remote-loss detection stays the
 * integrity scrub's job (ADR-0012) — this cache answers only "did the
 * SELECTED provider ever hold this object", which a provider switch resets. */
interface RemotePresence {
  providerId: string;
  readonly listed: Map<string, Set<string>>;
  readonly verified: Set<string>;
}

interface ReconcileOutcome {
  readonly uploadNow: readonly BackupItemPhoto[];
  readonly protectedRequeued: number;
  readonly blocked: number;
}

export class BackupEngine {
  private current: Promise<BackupRunResult> | null = null;
  /** A failed manifest upload owes the remote a generation. */
  private manifestOwed = false;
  private presence: RemotePresence | null = null;

  constructor(private readonly deps: BackupEngineDeps) {}

  /** Single-flight: a trigger during a run joins it (the dirty set is the
   * queue — anything newly dirtied is the NEXT run's work). */
  run(signal?: AbortSignal): Promise<BackupRunResult> {
    this.current ??= this.execute(signal).finally(() => {
      this.current = null;
    });
    return this.current;
  }

  /** The auto-backup-on-import subscription (#105): runs only when M09's
   * setting says so; failures are the run's own to report. */
  maybeAutoRun(): void {
    if (this.deps.settings().autoBackupOnImport) {
      void this.run().catch(() => undefined);
    }
  }

  /** The remote is owed a fresh manifest generation even with nothing
   * dirty (#120): soft-deleting an already-SYNCED photo changes
   * manifestSnapshot() without touching pendingCount, and a restore-from-backup
   * against the stale manifest would resurrect the deleted photo. */
  oweManifest(): void {
    this.setManifestOwed(true);
  }

  private setManifestOwed(owed: boolean): void {
    this.manifestOwed = owed;
    this.deps.manifestDebt?.save(owed);
  }

  private async execute(signal?: AbortSignal): Promise<BackupRunResult> {
    const settings = this.deps.settings();
    if (settings.wifiOnly && this.deps.network() === 'other') {
      // The Wi-Fi gate. 'unknown' (platform can't tell) deliberately does
      // NOT block — the unmetered heuristic recorded by ADR-0007/#105.
      return { uploaded: 0, failed: 0, manifestUploaded: true, skipped: 'wifi', integrity: EMPTY_INTEGRITY, blockedRemoteOnly: 0 };
    }
    if (this.deps.manifestDebt?.load() === true) {
      this.manifestOwed = true;
    }

    // OFFLOADED rows can dirty too (album/favorite edits in the Offloaded
    // view) — their blob is already remote and the machine rightly forbids
    // offloaded → syncing, so they are manifest-only debt: excluded from
    // the upload loop, settled after the manifest generation lands
    // (PR #274 review — before this they crashed the whole run).
    const dirty = this.deps.dirtyPhotos();
    const manifestOnly = dirty.filter((item) => item.status === 'offloaded');
    if (manifestOnly.length > 0) {
      this.setManifestOwed(true);
    }
    const items = dirty.filter((item) => item.status !== 'offloaded');
    const total = items.length;
    let uploaded = 0;
    let failed = 0;
    this.deps.events.progress(0, total, null);

    // The pending count is tracked incrementally: re-materializing the whole
    // dirty set per item made the sweep O(N²) (the 113K-import freeze). Only
    // a verified upload clears a row's dirt; failures leave it pending.
    // Rows dirtied concurrently emit their own count at the markDirty sites.
    let pending = dirty.length;
    let done = 0;
    let transientStreak = 0;
    for (const item of items) {
      if (signal?.aborted === true) {
        break; // dirty rows remain dirty — the next run resumes
      }
      const outcome = await this.uploadItem(item, settings, signal, (result) => {
        done += 1;
        if (result === 'uploaded') pending = Math.max(0, pending - 1);
        this.deps.events.progress(done, total, item.id);
        this.deps.pendingCountChanged(pending);
      });
      if (outcome === 'uploaded') uploaded += 1;
      else failed += 1;
      if (outcome === 'stop') break;
      if (outcome === 'failed-transient') {
        transientStreak += 1;
        if (transientStreak >= TRANSIENT_FAILURE_BREAK) {
          this.deps.audit(`BACKUP-CIRCUIT-BREAKER consecutive=${String(transientStreak)} remaining=${String(total - done)}`);
          console.error(
            `[overlook] backup aborted after ${String(transientStreak)} consecutive transient failures — dirty rows resume next run`,
          );
          break;
        }
      } else {
        transientStreak = 0;
      }
    }

    if (signal?.aborted !== true && this.deps.protectedBackup !== undefined) {
      if (this.deps.protectedBackup.hasManifestDebt()) this.setManifestOwed(true);
      const protectedResult = await this.deps.protectedBackup.run(signal);
      uploaded += protectedResult.uploaded;
      failed += protectedResult.failed;
      if (protectedResult.uploaded > 0) {
        // Protected uploads bypass this engine's verified-path notes, so a
        // cached protected listing from an earlier publish is stale now.
        this.invalidateListing('protected');
        this.setManifestOwed(true);
      }
    }

    // The fresh generation carries the offloaded rows' edits — their dirt
    // settles now, with no status change and no backup stamp. Idempotent:
    // a second publication in the same run must not settle (or decrement
    // the pending count) twice.
    let manifestOnlySettled = false;
    const settleManifestOnly = (): void => {
      if (manifestOnly.length === 0 || manifestOnlySettled) return;
      manifestOnlySettled = true;
      for (const item of manifestOnly) {
        this.deps.ledger.settleManifestOnly(item.id);
      }
      pending = Math.max(0, pending - manifestOnly.length);
      this.deps.pendingCountChanged(pending);
    };

    let manifestUploaded = true;
    let publishBlocked = false;
    let blockedRemoteOnly = 0;
    if (uploaded > 0 || this.manifestOwed) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await this.uploadManifest();
          this.setManifestOwed(false);
          manifestUploaded = true;
          publishBlocked = false;
          settleManifestOnly();
          break;
        } catch (error) {
          // Blobs landed and their rows are TRUTHFULLY synced — but the
          // remote is owed a manifest generation. The debt survives durably
          // and the result says so; the next run (manual or auto) retries
          // even with nothing dirty (PR #203 review).
          this.setManifestOwed(true);
          manifestUploaded = false;
          if (!(error instanceof ManifestIncompleteError)) {
            console.error(`[overlook] manifest upload failed: ${error instanceof Error ? error.message : String(error)}`);
            break;
          }
          publishBlocked = true;
          this.deps.audit(`MANIFEST-INCOMPLETE count=${String(error.missing.length)} first=${error.missing[0] ?? ''}`);
          // Signal state changes across awaits; a closure keeps each check live.
          const aborted = (): boolean => signal?.aborted === true;
          if (attempt > 0 || aborted()) break;
          // Reconcile once (#741): a claim the selected provider is missing
          // re-uploads from the local original right now; remote-only
          // claims (their verified copy lives on another provider) fail
          // the publication closed.
          const reconciled = this.reconcileMissing(error.missing);
          blockedRemoteOnly = reconciled.blocked;
          if (reconciled.blocked > 0) {
            this.deps.audit(`BACKUP-BLOCKED-REMOTE-ONLY provider=${this.deps.provider.id} count=${String(reconciled.blocked)}`);
          }
          let requeueFailed = 0;
          for (const item of reconciled.uploadNow) {
            if (aborted()) break;
            const outcome = await this.uploadItem(item, settings, signal, () => undefined);
            if (outcome === 'uploaded') uploaded += 1;
            else {
              failed += 1;
              requeueFailed += 1;
            }
            if (outcome === 'stop') break;
          }
          if (reconciled.protectedRequeued > 0 && !aborted() && this.deps.protectedBackup !== undefined) {
            const again = await this.deps.protectedBackup.run(signal);
            uploaded += again.uploaded;
            failed += again.failed;
            requeueFailed += again.failed;
            this.invalidateListing('protected');
          }
          const nothingRecovered = reconciled.uploadNow.length === 0 && reconciled.protectedRequeued === 0;
          if (reconciled.blocked > 0 || nothingRecovered || requeueFailed > 0 || aborted()) break;
        }
      }
    }
    let integrity = EMPTY_INTEGRITY;
    // publishBlocked is an integrity condition, not a transport failure —
    // the scrub still runs so remaining local-backed claims heal (bounded
    // pages, ADR-0012) instead of deadlocking behind the failed publish.
    // EXCEPT when remote-only claims belong to another provider
    // (blockedRemoteOnly): auditing those against the selected provider
    // would flip healthy offloaded rows to 'error' — the exact trap that
    // stranded the #741 library. No scrub until the claims are provable here.
    if (failed === 0 && blockedRemoteOnly === 0 && (manifestUploaded || publishBlocked)) {
      try {
        const ordinary = await this.deps.integrityScrub();
        const protectedSummary =
          this.deps.protectedBackup === undefined
            ? { checked: 0, repaired: 0, unrecoverable: 0, cycleComplete: true }
            : await this.deps.protectedBackup.scrub();
        const summary = {
          checked: ordinary.checked + protectedSummary.checked,
          repaired: ordinary.repaired + protectedSummary.repaired,
          unrecoverable: ordinary.unrecoverable + protectedSummary.unrecoverable,
        };
        const recoveryRepaired = !(await this.deps.recoveryGenerationHealthy());
        if (summary.repaired > 0) {
          // Scrub repairs put blobs behind the presence cache's back.
          this.invalidateListing('blobs');
          this.invalidateListing('protected');
        }
        if (summary.unrecoverable > 0) {
          // Confirmed remote-only loss (#741): fail truthfully. The last
          // valid retained generations stay untouched — publishing here
          // would seal a manifest promising blobs the provider just proved
          // it does not hold. The durable debt keeps the retry alive.
          this.setManifestOwed(true);
          manifestUploaded = false;
          this.deps.audit(`INTEGRITY-PUBLISH-BLOCKED unrecoverable=${String(summary.unrecoverable)}`);
        } else if (blockedRemoteOnly === 0 && (recoveryRepaired || (publishBlocked && summary.repaired > 0))) {
          // A repaired recovery index rides a fresh generation, and a scrub
          // that just re-uploaded missing blobs may satisfy the preflight
          // that blocked earlier in this run.
          this.setManifestOwed(true);
          try {
            await this.uploadManifest();
            this.setManifestOwed(false);
            manifestUploaded = true;
            settleManifestOnly();
            if (recoveryRepaired) {
              this.deps.audit('INTEGRITY-RECOVERY-REPAIRED');
            }
          } catch (error) {
            manifestUploaded = false;
            if (error instanceof ManifestIncompleteError) {
              this.deps.audit(`MANIFEST-INCOMPLETE count=${String(error.missing.length)} first=${error.missing[0] ?? ''}`);
            } else {
              throw error;
            }
          }
        }
        integrity = {
          checked: summary.checked,
          repaired: summary.repaired,
          unrecoverable: summary.unrecoverable,
          recoveryRepaired,
          failed: false,
        };
      } catch (error) {
        integrity = { ...EMPTY_INTEGRITY, failed: true };
        const reason = error instanceof Error ? error.message : String(error);
        this.deps.audit(`INTEGRITY-CHECK-FAILED reason=${reason}`);
        console.error(`[overlook] integrity check failed: ${reason}`);
      }
    }
    return { uploaded, failed, manifestUploaded, skipped: null, integrity, blockedRemoteOnly };
  }

  /** One verified item upload (#105/#106 semantics, extracted for the
   * preflight reconciliation path): syncing → put+retry → verify → synced.
   * 'stop' = auth/quota failure that ends the whole run; 'failed-transient'
   * feeds the sweep's circuit breaker. */
  private async uploadItem(
    item: BackupItemPhoto,
    settings: BackupSettings,
    signal: AbortSignal | undefined,
    progressed: (result: 'uploaded' | 'failed') => void,
  ): Promise<'uploaded' | 'failed' | 'failed-transient' | 'stop'> {
    const started = this.deps.now();
    let syncState: SyncStatus = 'synced';
    let outcome: 'uploaded' | 'failed' | 'failed-transient' | 'stop' = 'uploaded';
    try {
      // A row killed mid-upload resumes: it is already 'syncing' and the
      // machine (rightly) rejects syncing → syncing (PR #203 review).
      if (this.deps.ledger.status(item.id) !== 'syncing') {
        this.deps.ledger.setStatus(item.id, 'syncing');
      }
      const remotePath = blobPath(item.contentHash);
      await this.uploadWithRetry(remotePath, () => this.deps.encryptedStream(item.contentHash), signal);
      // Verify-after-upload (#106, ADR-0007): "backed up" is never a lie.
      // The LOCAL ciphertext hash is the truth the remote must match
      // before the row may go synced.
      const local = await this.hashLocalCiphertext(item.contentHash);
      const remote = await this.deps.provider.verify(remotePath);
      if (remote.sha256 !== local.sha256 || remote.bytes !== local.bytes) {
        this.deps.audit(
          `VERIFY-MISMATCH photo=${item.id} local=${local.sha256}/${String(local.bytes)} remote=${remote.sha256}/${String(remote.bytes)}`,
        );
        throw new ProviderError(`verify mismatch for ${item.fileName}`, 'corrupt');
      }
      this.deps.audit(`VERIFY-OK photo=${item.id} sha256=${local.sha256} bytes=${String(local.bytes)}`);
      this.deps.ledger.markBackedUp(item.id, new Date(this.deps.now()).toISOString());
      this.notePresent(remotePath);
    } catch (error) {
      outcome = error instanceof ProviderError && error.kind === 'transient' ? 'failed-transient' : 'failed';
      this.deps.ledger.markError(item.id);
      syncState = 'error';
      console.error(`[overlook] backup failed for ${item.fileName}: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof ProviderError && (error.kind === 'auth' || error.kind === 'quota')) {
        this.deps.syncStateChanged([{ id: item.id, syncState }]);
        return 'stop'; // retrying the rest cannot help — surface and stop
      }
    }
    progressed(outcome === 'uploaded' ? 'uploaded' : 'failed');
    this.deps.syncStateChanged([{ id: item.id, syncState }]);
    await this.throttle(settings, this.deps.now() - started);
    return outcome;
  }

  /** Maps preflight-missing paths back to their claims (#741). Locally
   * available synced originals re-queue (live rows dirty for crash-resume
   * truth, deleted-but-retained rows upload directly this run); everything
   * else is a remote-only claim that fails the publication closed. */
  private reconcileMissing(missing: readonly string[]): ReconcileOutcome {
    const blobHashes = missing
      .filter((path) => path.startsWith('blobs/'))
      .map((path) => path.split('/')[2])
      .filter((hash): hash is string => hash !== undefined);
    const claims = this.deps.claimsForContentHashes?.(blobHashes) ?? [];
    const claimedHashes = new Set(claims.map((claim) => claim.contentHash));
    const uploadNow: BackupItemPhoto[] = [];
    let blocked = 0;
    for (const claim of claims) {
      if (claim.status === 'synced' && this.deps.hasLocalOriginal?.(claim.contentHash) === true) {
        if (!claim.deleted && !this.deps.ledger.isDirty(claim.id)) this.deps.ledger.markDirty(claim.id);
        uploadNow.push({ id: claim.id, contentHash: claim.contentHash, bytes: claim.bytes, fileName: claim.fileName, keyId: claim.keyId });
      } else {
        blocked += 1;
      }
    }
    // Missing blobs with no synced/offloaded claim: with a local original
    // they belong to rows still in the dirty queue (local/error) — the
    // ordinary retry loop owns them, not this reconciliation. Without one,
    // NOTHING can produce the referenced blob, so the publication must
    // count them as blocked rather than retry forever.
    for (const hash of blobHashes) {
      if (!claimedHashes.has(hash) && this.deps.hasLocalOriginal?.(hash) !== true && this.deps.claimsForContentHashes !== undefined) {
        blocked += 1;
      }
    }
    const protectedMissing = missing.filter((path) => path.startsWith('protected/'));
    let protectedRequeued = 0;
    if (protectedMissing.length > 0) {
      const outcome = this.deps.protectedBackup?.reconcileMissing?.(protectedMissing) ?? { requeued: 0, blocked: protectedMissing.length };
      protectedRequeued = outcome.requeued;
      blocked += outcome.blocked;
    }
    return { uploadNow, protectedRequeued, blocked };
  }

  /** Politeness (#105): at p percent, rest (100-p)/p of each item's upload
   * time — 50% alternates work and rest; unlimited never sleeps. */
  private async throttle(settings: BackupSettings, elapsedMs: number): Promise<void> {
    const percent = settings.throttlePercent;
    if (percent === null || percent >= 100 || percent < 10) {
      return;
    }
    await this.deps.sleep(Math.round((elapsedMs * (100 - percent)) / percent));
  }

  private async uploadWithRetry(path: string, open: () => Readable, signal?: AbortSignal): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.deps.provider.put(path, open());
        return;
      } catch (error) {
        const transient = error instanceof ProviderError && error.kind === 'transient';
        if (!transient || attempt >= MAX_ATTEMPTS || signal?.aborted === true) {
          throw error;
        }
        await this.deps.sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }

  private async hashLocalCiphertext(contentHash: string): Promise<{ sha256: string; bytes: number }> {
    const hasher = createHash('sha256');
    let bytes = 0;
    const stream = this.deps.encryptedStream(contentHash);
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    await pipeline(stream, hasher);
    return { sha256: hasher.digest('hex'), bytes };
  }

  private presenceFor(): RemotePresence {
    const providerId = this.deps.provider.id;
    if (this.presence?.providerId !== providerId) {
      this.presence = { providerId, listed: new Map(), verified: new Set() };
    }
    return this.presence;
  }

  private notePresent(path: string): void {
    this.presenceFor().verified.add(path);
  }

  private invalidateListing(prefix: string): void {
    this.presenceFor().listed.delete(prefix);
  }

  private async listedPaths(prefix: string): Promise<ReadonlySet<string>> {
    const presence = this.presenceFor();
    let paths = presence.listed.get(prefix);
    if (paths === undefined) {
      paths = new Set((await this.deps.provider.list(prefix)).map((entry) => entry.path));
      presence.listed.set(prefix, paths);
    }
    return paths;
  }

  /** Publication preflight (#741): every ordinary and protected object the
   * manifest references must exist on the SELECTED provider. A switch, a
   * restore under a different selection, or a partial run can otherwise
   * seal a generation that promises blobs this remote never held. */
  private async assertManifestComplete(photos: readonly { readonly blobPath: string }[], protectedPaths: readonly string[]): Promise<void> {
    const missing: string[] = [];
    const verified = this.presenceFor().verified;
    if (photos.length > 0) {
      const present = await this.listedPaths('blobs');
      for (const photo of photos) {
        if (!present.has(photo.blobPath) && !verified.has(photo.blobPath)) missing.push(photo.blobPath);
      }
    }
    if (protectedPaths.length > 0) {
      const present = await this.listedPaths('protected');
      for (const path of protectedPaths) {
        if (!present.has(path) && !verified.has(path)) missing.push(path);
      }
    }
    if (missing.length > 0) {
      throw new ManifestIncompleteError(missing);
    }
  }

  /** Seals and uploads the next manifest generation; prunes past N=2. */
  private async uploadManifest(): Promise<void> {
    const generatedAt = new Date(this.deps.now()).toISOString();
    const protectedSnapshot = this.deps.protectedBackup?.snapshot();
    const manifest = buildBackupManifestV5({
      libraryId: this.deps.libraryId(),
      generatedAt,
      snapshot: {
        ...this.deps.manifestSnapshot(),
        protectedAlbums: protectedSnapshot?.protectedAlbums ?? [],
        protectedPhotos: protectedSnapshot?.protectedPhotos ?? [],
        activity: this.deps.activitySnapshot?.() ?? [],
        boards: this.deps.boardsSnapshot?.() ?? [],
      } satisfies BackupManifestSnapshotV5,
    });
    // Preflight before ANY remote write of this publication — a blocked
    // generation must not upload, prune, or even refresh the bootstrap.
    await this.assertManifestComplete(
      manifest.photos,
      manifest.protectedPhotos.flatMap((photo) => photo.objects.map((object) => object.path)),
    );
    const json = JSON.stringify(manifest);
    const sealed = await this.deps.sealManifest(json);
    // The bootstrap is a superset across rotations and lands first: a crash
    // can leave an old manifest with newer wrapped keys, never a manifest
    // whose envelope key cannot be resolved on a fresh machine.
    const bootstrap = this.deps.sealRecoveryBootstrap(generatedAt);
    await this.putBufferVerified('recovery/bootstrap.ovrb', bootstrap);
    const existing = await this.deps.provider.list('manifest');
    const generation = existing.reduce((max, entry) => {
      const match = /gen-(\d+)\.ovlk$/u.exec(entry.path);
      return match === null ? max : Math.max(max, Number(match[1]));
    }, 0);
    await this.putBufferVerified(`manifest/gen-${String(generation + 1)}.ovlk`, sealed);
    const all = await this.deps.provider.list('manifest');
    const sorted = [...all].sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
    for (const stale of sorted.slice(0, Math.max(0, sorted.length - MANIFEST_KEEP))) {
      await this.deps.provider.delete(stale.path);
    }
    if (protectedSnapshot !== undefined) this.deps.protectedBackup?.settleManifest(protectedSnapshot);
  }

  private async putBufferVerified(path: string, bytes: Buffer): Promise<void> {
    await this.deps.provider.put(path, Readable.from([bytes]));
    const remote = await this.deps.provider.verify(path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (remote.sha256 !== sha256 || remote.bytes !== bytes.length) {
      throw new ProviderError(`verify mismatch for ${path}`, 'corrupt');
    }
  }
}
