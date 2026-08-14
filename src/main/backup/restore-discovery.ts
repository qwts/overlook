import { createHash } from 'node:crypto';
import { addAbortSignal, Readable } from 'node:stream';

import { createDecryptStream, type KeyResolver } from '../crypto/envelope.js';
import { MIGRATIONS } from '../db/migrations.js';
import { parseBackupManifest, type RestorableBackupManifest } from './backup-manifest.js';
import { openRecoveryBootstrap, recoveryBootstrapResolver, type RecoveryBootstrap } from './recovery-bootstrap.js';
import { ProviderError, type RemoteEntry, type StorageProvider } from './provider.js';
import { RestoreError, toRestoreError } from './restore-types.js';

const MAX_BOOTSTRAP_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MANIFEST_PATH = /^manifest\/gen-(\d+)\.ovlk$/u;
const CURRENT_DATABASE_SCHEMA = Math.max(...MIGRATIONS.map((migration) => migration.version));

class StaleRecoveryBootstrapError extends Error {
  override readonly name = 'StaleRecoveryBootstrapError';
}

export interface RestoreCandidate {
  readonly path: string;
  readonly generation: number;
  readonly sealedSha256: string;
  readonly manifest: RestorableBackupManifest;
}

export interface RestoreDiscovery {
  readonly bootstrap: RecoveryBootstrap;
  readonly resolveKey: KeyResolver;
  /** Highest advertised generation, even when its manifest is invalid. */
  readonly newestGeneration: number;
  readonly candidates: readonly RestoreCandidate[];
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new RestoreError('cancelled', 'restore cancelled');
}

async function readLimited(stream: Readable, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  const source = signal === undefined ? stream : addAbortSignal(signal, stream);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of source) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    length += chunk.length;
    if (length > maximum) {
      source.destroy();
      throw new RestoreError('corrupt', `remote object exceeds ${String(maximum)} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function generationOf(entry: RemoteEntry): number | null {
  const match = MANIFEST_PATH.exec(entry.path);
  if (match === null) return null;
  const generation = Number(match[1]);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : null;
}

function validateManifest(manifest: RestorableBackupManifest, bootstrap: RecoveryBootstrap, resolveKey: KeyResolver): void {
  if (manifest.libraryId !== bootstrap.libraryId) {
    throw new RestoreError('corrupt', 'manifest library id does not match the recovery bootstrap');
  }
  if (Date.parse(bootstrap.generatedAt) < Date.parse(manifest.generatedAt)) {
    throw new StaleRecoveryBootstrapError('manifest is newer than the recovery bootstrap');
  }
  if (manifest.databaseSchema > CURRENT_DATABASE_SCHEMA) {
    throw new RestoreError(
      'unsupported',
      `manifest database schema ${String(manifest.databaseSchema)} is newer than ${String(CURRENT_DATABASE_SCHEMA)}`,
    );
  }
  for (const keyId of manifest.keyIds) {
    if (resolveKey(keyId) === undefined) throw new RestoreError('wrong-key', `manifest key ${String(keyId)} is unavailable`);
  }
  const blobPaths = new Set<string>();
  for (const photo of manifest.photos) {
    if (blobPaths.has(photo.blobPath)) throw new RestoreError('corrupt', `duplicate blob reference ${photo.blobPath}`);
    blobPaths.add(photo.blobPath);
  }
}

function assertManifestNotNewerThanBootstrap(value: unknown, bootstrap: RecoveryBootstrap): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const generatedAt = (value as { readonly generatedAt?: unknown }).generatedAt;
  if (typeof generatedAt !== 'string') return;
  const manifestTimestamp = Date.parse(generatedAt);
  if (Number.isFinite(manifestTimestamp) && Date.parse(bootstrap.generatedAt) < manifestTimestamp) {
    throw new StaleRecoveryBootstrapError('manifest is newer than the recovery bootstrap');
  }
}

async function openCandidate(
  provider: StorageProvider,
  entry: RemoteEntry,
  generation: number,
  bootstrap: RecoveryBootstrap,
  resolveKey: KeyResolver,
  signal?: AbortSignal,
): Promise<RestoreCandidate> {
  assertNotAborted(signal);
  const sealed = await readLimited(await provider.getStream(entry.path), MAX_MANIFEST_BYTES, signal);
  let unavailableKeyId: number | null = null;
  const trackedResolver: KeyResolver = (keyId) => {
    const key = resolveKey(keyId);
    if (key === undefined) unavailableKeyId = keyId;
    return key;
  };
  let plaintext: Buffer;
  try {
    plaintext = await readLimited(
      Readable.from([sealed]).pipe(createDecryptStream(trackedResolver, { photoId: 'manifest' })),
      MAX_MANIFEST_BYTES,
      signal,
    );
  } catch (error) {
    if (unavailableKeyId !== null) {
      throw new RestoreError('wrong-key', `manifest key ${String(unavailableKeyId)} is unavailable`);
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(plaintext.toString('utf8')) as unknown;
  } catch {
    throw new RestoreError('corrupt', `${entry.path} is not valid JSON`);
  }
  assertManifestNotNewerThanBootstrap(json, bootstrap);
  const parsed = parseBackupManifest(json);
  if (!parsed.restorable) throw new RestoreError('unsupported', `${entry.path} uses non-restorable schema 1`);
  validateManifest(parsed.manifest, bootstrap, resolveKey);
  return {
    path: entry.path,
    generation,
    sealedSha256: createHash('sha256').update(sealed).digest('hex'),
    manifest: parsed.manifest,
  };
}

export async function discoverRestore(provider: StorageProvider, masterKey: Buffer, signal?: AbortSignal): Promise<RestoreDiscovery> {
  try {
    assertNotAborted(signal);
    if ((await provider.authState()) !== 'connected') throw new RestoreError('auth', 'backup provider is not connected');
    const bootstrapBytes = await readLimited(await provider.getStream('recovery/bootstrap.ovrb'), MAX_BOOTSTRAP_BYTES, signal);
    let bootstrap: RecoveryBootstrap;
    try {
      bootstrap = openRecoveryBootstrap(bootstrapBytes, masterKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = /authentication|wrapped key/u.test(message) ? 'wrong-key' : 'corrupt';
      throw new RestoreError(reason, message);
    }
    const resolveKey = recoveryBootstrapResolver(bootstrap, masterKey);
    const entries = (await provider.list('manifest'))
      .map((entry) => ({ entry, generation: generationOf(entry) }))
      .filter((item): item is { entry: RemoteEntry; generation: number } => item.generation !== null)
      .sort((left, right) => right.generation - left.generation);
    const candidates: RestoreCandidate[] = [];
    for (const { entry, generation } of entries) {
      try {
        candidates.push(await openCandidate(provider, entry, generation, bootstrap, resolveKey, signal));
      } catch (error) {
        if (error instanceof StaleRecoveryBootstrapError) {
          throw new RestoreError('corrupt', error.message);
        }
        const mapped = toRestoreError(error);
        if (
          mapped.reason === 'auth' ||
          mapped.reason === 'offline' ||
          (mapped.reason === 'wrong-key' && candidates.length === 0) ||
          (error instanceof ProviderError && error.kind === 'transient' && error.scope === 'object') ||
          mapped.reason === 'cancelled'
        ) {
          throw mapped;
        }
      }
    }
    if (candidates.length === 0) throw new RestoreError('corrupt', 'no valid restorable manifest generation was found');
    const newestGeneration = entries[0]?.generation;
    if (newestGeneration === undefined) throw new RestoreError('corrupt', 'no manifest generation was found');
    return { bootstrap, resolveKey, newestGeneration, candidates };
  } catch (error) {
    throw toRestoreError(error);
  }
}
