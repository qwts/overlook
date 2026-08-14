import type { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import { ProviderError, type ProviderAuthState, type StorageProvider } from './provider.js';
import { CustodyResolutionError, type CustodyHandle, type CustodyHandleResolver } from './custody-handle.js';
import type { SyncLedger } from './sync-ledger.js';
import type { SyncStatus } from '../../shared/library/types.js';

// Offload + rehydrate (#107, ADR-0007): originals live only in the cloud,
// safely, and come back when needed. Eligibility trusts the verified bit
// (#106): only synced-and-clean rows evict; thumbnails always stay so the
// library browses offline. Rehydrate is atomic — download, restore staged,
// decrypt-and-rehash verify, only then flip the ledger; any failure leaves
// a clean offloaded record, never a half-restored one.

export type OffloadSkipReason =
  | 'missing-photo'
  | 'deleted'
  | 'provider-disconnected'
  | 'provider-expired'
  | 'provider-offline'
  | 'local'
  | 'syncing'
  | 'already-offloaded'
  | 'error'
  | 'dirty'
  | 'shared-original'
  | 'missing-original'
  | 'remote-missing'
  | 'remote-mismatch'
  | 'remote-unverified';

export interface OffloadPreflightItem {
  readonly photoId: string;
  readonly bytes: number;
  readonly eligible: boolean;
  readonly reason: OffloadSkipReason | null;
}

export interface OffloadPreflight {
  readonly eligible: number;
  readonly ineligible: number;
  readonly estimatedFreedBytes: number;
  readonly items: readonly OffloadPreflightItem[];
}

export interface OffloadResultItem {
  readonly photoId: string;
  readonly outcome: 'offloaded' | 'skipped' | 'failed';
  readonly reason: OffloadSkipReason | 'delete-failed' | null;
}

export interface OffloadSummary {
  readonly offloaded: number;
  readonly skipped: number;
  readonly failed: number;
  readonly freedBytes: number;
  readonly results: readonly OffloadResultItem[];
}

export type RestoreOriginalFailureReason =
  'not-offloaded' | 'custody-disconnected' | 'custody-wrong-account' | 'custody-unavailable' | 'download-failed' | 'verify-failed';

export interface RestoreOriginalResultItem {
  readonly photoId: string;
  readonly outcome: 'restored' | 'skipped' | 'failed';
  readonly reason: RestoreOriginalFailureReason | null;
}

export interface RestoreOriginalsSummary {
  readonly restored: number;
  readonly skipped: number;
  readonly failed: number;
  readonly results: readonly RestoreOriginalResultItem[];
}

export class RehydrateError extends Error {
  override readonly name = 'RehydrateError';

  constructor(
    message: string,
    readonly reason: RestoreOriginalFailureReason,
  ) {
    super(message);
  }
}

export interface OffloadDeps {
  readonly provider: StorageProvider;
  /** Settings/provider-registry truth. The active-provider facade has a
   * fallback target while disconnected, so authState alone is insufficient. */
  readonly providerConnected: () => boolean;
  /** Captures the verified backup target before local custody is removed. */
  readonly offloadAuthority: (bytes: number) => Promise<number>;
  readonly custodyChanged: () => void;
  /** Sole-remote reads resolve from row provenance, never provider selection. */
  readonly custody: Pick<CustodyHandleResolver, 'resolve'>;
  readonly ledger: SyncLedger;
  readonly repo: {
    readonly get: (id: string) => { contentHash: string; bytes: number; deletedAt: string | null } | undefined;
    /** Live photos (not deleted) sharing this content hash. */
    readonly countByContentHash: (hash: string) => number;
    readonly offloadedIds: () => readonly string[];
  };
  readonly ledgerDirty: (photoId: string) => boolean;
  readonly blobs: {
    readonly deleteOriginal: (contentHash: string) => Promise<void>;
    readonly hasOriginal: (contentHash: string) => boolean;
    readonly encryptedStream: (contentHash: string) => Readable;
    /** Atomic restore of raw ciphertext; must verify before publishing. */
    readonly restoreOriginal: (contentHash: string, ciphertext: Readable, photoId: string) => Promise<void>;
  };
  readonly syncStateChanged: (updates: readonly { readonly id: string; readonly syncState: SyncStatus }[]) => void;
  readonly storageChanged: () => void;
  readonly audit: (line: string) => void;
}

function blobPath(contentHash: string): string {
  return `blobs/${contentHash.slice(0, 2)}/${contentHash}`;
}

export class OffloadService {
  constructor(private readonly deps: OffloadDeps) {}

  status(photoId: string): SyncStatus | undefined {
    return this.deps.ledger.status(photoId);
  }

  /** Read-only, exact plan used by every confirmation surface. */
  async preflight(photoIds: readonly string[]): Promise<OffloadPreflight> {
    const providerState = await this.providerState();
    const items: OffloadPreflightItem[] = [];
    for (const photoId of new Set(photoIds)) items.push(await this.classify(photoId, providerState));
    const eligibleItems = items.filter((item) => item.eligible);
    return {
      eligible: eligibleItems.length,
      ineligible: items.length - eligibleItems.length,
      estimatedFreedBytes: eligibleItems.reduce((sum, item) => sum + item.bytes, 0),
      items,
    };
  }

  /** Evicts verified-synced originals; anything else is reported with an
   * exact reason, never silently forced. Thumbs stay browsable offline. */
  async offload(photoIds: readonly string[]): Promise<OffloadSummary> {
    const providerState = await this.providerState();
    let offloaded = 0;
    let skipped = 0;
    let failed = 0;
    let freedBytes = 0;
    const changed: string[] = [];
    const results: OffloadResultItem[] = [];
    for (const photoId of new Set(photoIds)) {
      // The provider-switch lock covers this entire method. Verify the
      // active provider's ciphertext immediately before local deletion so
      // a stale synced ledger entry from another account/provider cannot
      // authorize eviction.
      const current = await this.classify(photoId, providerState);
      const photo = this.deps.repo.get(photoId);
      if (!current.eligible || photo === undefined) {
        skipped += 1;
        results.push({ photoId, outcome: 'skipped', reason: current.reason ?? 'missing-photo' });
        continue;
      }
      let authorityId: number;
      try {
        authorityId = await this.deps.offloadAuthority(photo.bytes);
        // The authority may have become provider-required after identity was
        // captured. Keep the prospective hint conservative, then let the
        // ledger's transactional state check refuse the binding.
        this.deps.ledger.markOffloaded(photoId, authorityId);
      } catch (error) {
        this.deps.custodyChanged();
        failed += 1;
        results.push({ photoId, outcome: 'failed', reason: 'remote-unverified' });
        this.deps.audit(`OFFLOAD-FAIL photo=${photoId} stage=binding reason=${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      // Persist the sole-remote state and exact authority before removing
      // local bytes. A crash can leave a harmless extra local copy, never an
      // unbound cloud-only row that startup repair cannot recover.
      try {
        await this.deps.blobs.deleteOriginal(photo.contentHash);
      } catch (error) {
        try {
          this.deps.ledger.setStatus(photoId, 'synced');
          this.deps.custodyChanged();
        } catch (rollbackError) {
          this.deps.audit(
            `OFFLOAD-FAIL photo=${photoId} stage=rollback reason=${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
        failed += 1;
        results.push({ photoId, outcome: 'failed', reason: 'delete-failed' });
        this.deps.audit(`OFFLOAD-FAIL photo=${photoId} stage=delete reason=${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      this.deps.custodyChanged();
      this.deps.audit(`OFFLOAD photo=${photoId} bytes=${String(photo.bytes)}`);
      offloaded += 1;
      freedBytes += photo.bytes;
      changed.push(photoId);
      results.push({ photoId, outcome: 'offloaded', reason: null });
    }
    if (changed.length > 0) {
      this.deps.syncStateChanged(changed.map((id) => ({ id, syncState: 'offloaded' })));
      this.deps.storageChanged();
    }
    return { offloaded, skipped, failed, freedBytes, results };
  }

  private async providerState(): Promise<ProviderAuthState | 'offline'> {
    if (!this.deps.providerConnected()) {
      return 'not-connected';
    }
    try {
      return await this.deps.provider.authState();
    } catch {
      return 'offline';
    }
  }

  private async classify(photoId: string, providerState: ProviderAuthState | 'offline'): Promise<OffloadPreflightItem> {
    const photo = this.deps.repo.get(photoId);
    if (photo === undefined) return { photoId, bytes: 0, eligible: false, reason: 'missing-photo' };
    if (photo.deletedAt !== null) return { photoId, bytes: photo.bytes, eligible: false, reason: 'deleted' };
    const status = this.deps.ledger.status(photoId);
    const statusReason: Partial<Record<SyncStatus, OffloadSkipReason>> = {
      local: 'local',
      syncing: 'syncing',
      offloaded: 'already-offloaded',
      error: 'error',
    };
    const reason = status === undefined ? 'missing-photo' : statusReason[status];
    if (reason !== undefined) return { photoId, bytes: photo.bytes, eligible: false, reason };
    if (this.deps.ledgerDirty(photoId)) return { photoId, bytes: photo.bytes, eligible: false, reason: 'dirty' };
    if (!this.deps.blobs.hasOriginal(photo.contentHash)) {
      return { photoId, bytes: photo.bytes, eligible: false, reason: 'missing-original' };
    }
    if (this.deps.repo.countByContentHash(photo.contentHash) > 1) {
      return { photoId, bytes: photo.bytes, eligible: false, reason: 'shared-original' };
    }
    if (providerState === 'not-connected') {
      return { photoId, bytes: photo.bytes, eligible: false, reason: 'provider-disconnected' };
    }
    if (providerState === 'expired') return { photoId, bytes: photo.bytes, eligible: false, reason: 'provider-expired' };
    if (providerState === 'offline') return { photoId, bytes: photo.bytes, eligible: false, reason: 'provider-offline' };
    const remoteReason = await this.verifyActiveRemote(photoId, photo.contentHash);
    if (remoteReason !== null) return { photoId, bytes: photo.bytes, eligible: false, reason: remoteReason };
    return { photoId, bytes: photo.bytes, eligible: true, reason: null };
  }

  private async verifyActiveRemote(photoId: string, contentHash: string): Promise<OffloadSkipReason | null> {
    let local: { readonly sha256: string; readonly bytes: number };
    try {
      local = await this.hashLocalCiphertext(contentHash);
    } catch (error) {
      this.deps.audit(`OFFLOAD-VERIFY-FAIL photo=${photoId} side=local reason=${error instanceof Error ? error.message : String(error)}`);
      return 'missing-original';
    }
    try {
      const remote = await this.deps.provider.verify(blobPath(contentHash));
      if (remote.sha256 !== local.sha256 || remote.bytes !== local.bytes) {
        this.deps.audit(`OFFLOAD-VERIFY-FAIL photo=${photoId} side=remote reason=mismatch`);
        return 'remote-mismatch';
      }
      return null;
    } catch (error) {
      const reason =
        error instanceof ProviderError
          ? error.kind === 'auth'
            ? 'provider-expired'
            : error.kind === 'not-found'
              ? 'remote-missing'
              : error.kind === 'corrupt'
                ? 'remote-mismatch'
                : error.kind === 'transient'
                  ? 'provider-offline'
                  : 'remote-unverified'
          : 'remote-unverified';
      this.deps.audit(`OFFLOAD-VERIFY-FAIL photo=${photoId} side=remote reason=${reason}`);
      return reason;
    }
  }

  private async hashLocalCiphertext(contentHash: string): Promise<{ sha256: string; bytes: number }> {
    const hasher = createHash('sha256');
    let bytes = 0;
    const stream = this.deps.blobs.encryptedStream(contentHash);
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    await pipeline(stream, hasher);
    return { sha256: hasher.digest('hex'), bytes };
  }

  /** Download → staged restore → decrypt-and-rehash verify → synced. */
  async rehydrate(photoId: string): Promise<void> {
    await this.restoreOriginal(photoId);
    this.notifyRestored([photoId]);
  }

  private async restoreOriginal(photoId: string): Promise<void> {
    const photo = this.deps.repo.get(photoId);
    if (photo === undefined || this.deps.ledger.status(photoId) !== 'offloaded') {
      throw new RehydrateError(`photo ${photoId} is not offloaded`, 'not-offloaded');
    }
    let custody: CustodyHandle;
    try {
      custody = await this.deps.custody.resolve(photoId);
    } catch (error) {
      if (error instanceof CustodyResolutionError) {
        throw new RehydrateError(error.message, error.reason);
      }
      throw new RehydrateError('custody is unavailable', 'custody-unavailable');
    }
    if (!this.deps.blobs.hasOriginal(photo.contentHash)) {
      let ciphertext: Readable;
      try {
        ciphertext = await custody.provider.getStream(blobPath(photo.contentHash));
      } catch (error) {
        this.deps.audit(`REHYDRATE-FAIL photo=${photoId} stage=download`);
        throw new RehydrateError(error instanceof ProviderError ? error.message : 'download failed', 'download-failed');
      }
      // restoreOriginal verifies (decrypt + re-hash against the content
      // address) BEFORE publishing; a bad download never becomes local
      // truth and the record stays cleanly offloaded.
      await this.deps.blobs.restoreOriginal(photo.contentHash, ciphertext, photoId).catch((error: unknown) => {
        this.deps.audit(`REHYDRATE-FAIL photo=${photoId} stage=verify`);
        throw new RehydrateError(error instanceof Error ? error.message : 'restore failed', 'verify-failed');
      });
    }
    this.deps.ledger.setStatus(photoId, 'synced');
    this.deps.custodyChanged();
    this.deps.audit(`REHYDRATE-OK photo=${photoId}`);
  }

  /** Batch restore for selection and Settings. Omit ids to restore every
   * live offloaded original. Failures are isolated and exactly reported. */
  async restoreOriginals(photoIds?: readonly string[]): Promise<RestoreOriginalsSummary> {
    const ids = [...new Set(photoIds ?? this.deps.repo.offloadedIds())];
    let restored = 0;
    let skipped = 0;
    let failed = 0;
    const restoredIds: string[] = [];
    const results: RestoreOriginalResultItem[] = [];
    for (const photoId of ids) {
      try {
        await this.restoreOriginal(photoId);
        restored += 1;
        restoredIds.push(photoId);
        results.push({ photoId, outcome: 'restored', reason: null });
      } catch (error) {
        const reason = error instanceof RehydrateError ? error.reason : 'verify-failed';
        if (reason === 'not-offloaded') {
          skipped += 1;
          results.push({ photoId, outcome: 'skipped', reason });
        } else {
          failed += 1;
          results.push({ photoId, outcome: 'failed', reason });
        }
      }
    }
    this.notifyRestored(restoredIds);
    return { restored, skipped, failed, results };
  }

  private notifyRestored(photoIds: readonly string[]): void {
    if (photoIds.length === 0) return;
    this.deps.syncStateChanged(photoIds.map((id) => ({ id, syncState: 'synced' })));
    this.deps.storageChanged();
  }
}
