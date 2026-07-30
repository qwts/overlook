import { ProviderError, type StorageProvider } from '../backup/provider.js';
import type { PhotoRecord } from '../../shared/library/types.js';
import { trashRetentionDays, type TrashRetention } from '../../shared/library/trash.js';

export { createPurgeRepository } from './purge-repository.js';

// Permanent purge (#121): the one truly destructive path, done with
// ceremony. Repair-friendly order per the issue: DB row FIRST (nothing ever
// points at missing data), local blobs second, remote last — a crash or a
// failed remote delete leaves orphaned copies (repairable, M11 audits find
// them via the ORPHAN-REMOTE audit line), never a row that lies about
// having data. Retention reads the active library setting at sweep time, so
// library switches and setting changes cannot leave a captured stale window.

const REMOTE_ATTEMPTS = 3;
const REMOTE_BACKOFF_MS = 500;

export interface PurgeSummary {
  readonly purged: number;
  readonly skipped: number;
  readonly protected: number;
  /** Remote copies left behind (audited) — retried on later purges never
   * silently forgotten. */
  readonly remoteFailures: number;
}

export interface PurgeDeps {
  readonly repo: {
    readonly getDeleted: (photoId: string) => PhotoRecord | undefined;
    readonly getAny: (photoId: string) => PhotoRecord | undefined;
    readonly purgeRow: (photoId: string) => void;
    readonly purgeRowAuthorized: (photoId: string) => void;
    readonly countAnyByContentHash: (hash: string) => number;
    readonly expiredDeleted: (cutoffIso: string) => string[];
    /** Companion custody hashes — captured BEFORE purgeRow CASCADEs the
     * sidecar rows away (#484). */
    readonly sidecarHashesForPhoto: (photoId: string) => readonly string[];
  };
  readonly blobs: {
    readonly deleteOriginal: (contentHash: string) => Promise<void>;
    readonly deleteThumbs: (contentHash: string) => Promise<void>;
    /** Removes the photo's whole companion set (#484). */
    readonly deleteSidecars: (photoId: string) => Promise<void>;
  };
  readonly provider: StorageProvider;
  readonly connected: () => boolean;
  /** Purging changes manifestSnapshot() — the remote is owed a generation. */
  readonly oweManifest: () => void;
  readonly libraryChanged: (photoIds: readonly string[]) => void;
  readonly audit: (line: string) => void;
  readonly retention: () => TrashRetention;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

function blobPath(contentHash: string): string {
  return `blobs/${contentHash.slice(0, 2)}/${contentHash}`;
}

export class PurgeService {
  constructor(private readonly deps: PurgeDeps) {}

  /** Purges soft-deleted rows: DB row → local blobs → remote (retried).
   * Live rows are skipped, never forced. */
  async purge(photoIds: readonly string[], signal?: AbortSignal): Promise<PurgeSummary> {
    return this.remove(photoIds, false, signal);
  }

  /** Shift+Delete after main-process authorization: live and protected rows
   * may cross the irreversible boundary, but custody cleanup remains shared. */
  async deletePermanently(photoIds: readonly string[], signal?: AbortSignal): Promise<PurgeSummary> {
    return this.remove(photoIds, true, signal);
  }

  private async remove(photoIds: readonly string[], authorized: boolean, signal?: AbortSignal): Promise<PurgeSummary> {
    let purged = 0;
    let skipped = 0;
    let protectedCount = 0;
    let remoteFailures = 0;
    const changed: string[] = [];
    for (const photoId of photoIds) {
      // A purge that already removed a row finishes that photo's repairable
      // local/remote cleanup. Cancellation takes effect only between photos.
      if (signal?.aborted === true) break;
      const photo = authorized ? this.deps.repo.getAny(photoId) : this.deps.repo.getDeleted(photoId);
      if (photo === undefined) {
        skipped += 1;
        continue;
      }
      if (photo.isOriginal && !authorized) {
        protectedCount += 1;
        continue;
      }
      // Sidecar custody is per photo (#484): captured before the row purge
      // CASCADEs the companion rows away, deleted with the photo, and a
      // failed remote delete stays visible via the same audited counter.
      const sidecarHashes = this.deps.repo.sidecarHashesForPhoto(photoId);
      if (authorized) this.deps.repo.purgeRowAuthorized(photoId);
      else this.deps.repo.purgeRow(photoId);
      // Content-addressed blobs may back other rows (deleted twins count —
      // they still own their bytes until their own purge).
      if (this.deps.repo.countAnyByContentHash(photo.contentHash) === 0) {
        await this.deps.blobs.deleteOriginal(photo.contentHash);
        await this.deps.blobs.deleteThumbs(photo.contentHash);
        remoteFailures += await this.deleteRemote(photoId, photo.contentHash, blobPath(photo.contentHash));
      }
      await this.deps.blobs.deleteSidecars(photoId);
      for (const hash of sidecarHashes) {
        remoteFailures += await this.deleteRemote(photoId, hash, `sidecars/${photoId}/${hash}`);
      }
      this.deps.audit(`PURGE photo=${photoId} bytes=${String(photo.bytes)}`);
      purged += 1;
      changed.push(photoId);
    }
    if (changed.length > 0) {
      // The purged rows left manifestSnapshot() with nothing dirty — the host
      // owes (and quietly pushes) a fresh generation, like soft delete.
      this.deps.oweManifest();
      this.deps.libraryChanged(changed);
    }
    return { purged, skipped, protected: protectedCount, remoteFailures };
  }

  /** The retention sweep (#121): everything older than the window goes. */
  async purgeExpired(signal?: AbortSignal): Promise<PurgeSummary> {
    const retention = this.deps.retention();
    const retentionDays = trashRetentionDays(retention);
    if (retentionDays === null) return { purged: 0, skipped: 0, protected: 0, remoteFailures: 0 };
    const cutoff = new Date(this.deps.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const expired = this.deps.repo.expiredDeleted(cutoff);
    if (expired.length === 0) {
      return { purged: 0, skipped: 0, protected: 0, remoteFailures: 0 };
    }
    this.deps.audit(`PURGE-RETENTION count=${String(expired.length)} days=${String(retentionDays)} cutoff=${cutoff}`);
    return this.purge(expired, signal);
  }

  /** Remote last, tolerated: 'not-found' is success (already gone),
   * transient errors retry with backoff, a final failure is audited as an
   * orphan for M11's audits — the local state never lies either way. */
  private async deleteRemote(photoId: string, contentHash: string, remotePath: string): Promise<0 | 1> {
    if (!this.deps.connected()) {
      this.deps.audit(`ORPHAN-REMOTE photo=${photoId} hash=${contentHash} path=${remotePath} reason=disconnected`);
      return 1;
    }
    for (let attempt = 1; attempt <= REMOTE_ATTEMPTS; attempt += 1) {
      try {
        await this.deps.provider.delete(remotePath);
        return 0;
      } catch (error) {
        if (error instanceof ProviderError && error.kind === 'not-found') {
          return 0;
        }
        if (attempt === REMOTE_ATTEMPTS) {
          const reason = error instanceof Error ? error.message : 'unknown';
          this.deps.audit(`ORPHAN-REMOTE photo=${photoId} hash=${contentHash} path=${remotePath} reason=${reason}`);
          return 1;
        }
        await this.deps.sleep(REMOTE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
    return 1;
  }
}
