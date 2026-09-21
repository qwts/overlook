import type { CustodyAuthority, CustodyAuthorityRepository } from '../backup/custody-authority-repository.js';
import type { CustodyHandleResolver } from '../backup/custody-handle.js';
import { ProviderError } from '../backup/provider.js';
import type { PurgeCleanupRepository } from './purge-cleanup-repository.js';

export interface PurgeCleanupDeps {
  readonly repo: PurgeCleanupRepository;
  readonly authorities: Pick<CustodyAuthorityRepository, 'get'>;
  readonly custody: Pick<CustodyHandleResolver, 'resolveAuthority'>;
  readonly captureAuthority: (photoId: string) => Promise<CustodyAuthority>;
  readonly ensureTargetAuthority: () => Promise<CustodyAuthority>;
  readonly audit: (line: string) => void;
}

/** Exclusion cleanup survives both row deletion and process restart. A
 * published manifest is a per-item barrier, never a blanket queue flush. */
export class PurgeCleanupService {
  private eligible = new Set<number>();
  constructor(private readonly deps: PurgeCleanupDeps) {}

  async transfer(photoId: string, removeRow: () => void): Promise<number> {
    const authority = this.deps.repo.needsAuthority(photoId) ? await this.deps.captureAuthority(photoId) : undefined;
    return this.deps.repo.transferAndPurge(photoId, authority?.id, removeRow);
  }

  hasManifestDebt(): boolean {
    return this.deps.repo.hasManifestDebt();
  }

  /** Captured before the ordinary manifest snapshot. Only a publication to
   * the same source account/root can release its deletion barrier. */
  async snapshot(): Promise<readonly number[]> {
    this.eligible.clear();
    const pending = this.deps.repo.pending();
    if (pending.length === 0) return [];
    const target = await this.deps.ensureTargetAuthority();
    return pending.filter((item) => item.authorityId === target.id).map((item) => item.id);
  }

  settleManifest(ids: readonly number[], retainedPaths: readonly string[]): void {
    const captured = new Set(ids);
    const retained = new Set(retainedPaths);
    this.eligible = new Set(
      this.deps.repo
        .pending()
        .filter((item) => captured.has(item.id) && !retained.has(item.remotePath))
        .map((item) => item.id),
    );
  }

  async retry(signal?: AbortSignal): Promise<{ settled: number; pending: number }> {
    let settled = 0;
    const eligible = this.eligible;
    this.eligible = new Set();
    const aborted = (): boolean => signal?.aborted === true;
    for (const item of this.deps.repo.pending()) {
      if (aborted()) break;
      if (!eligible.has(item.id)) continue;
      // An included sibling defers this original-removal request.
      // Sidecars are per-photo objects and do not share the original's gate.
      if (item.kind === 'original' && this.deps.repo.hasIncludedReference(item.contentHash)) {
        continue;
      }
      try {
        const authority = this.deps.authorities.get(item.authorityId);
        if (authority === undefined) throw new Error('source authority unavailable');
        const handle = await this.deps.custody.resolveAuthority(authority);
        if (aborted()) break;
        // A resolver can await reconnect proof; check sharing again after it.
        if (item.kind === 'original' && this.deps.repo.hasIncludedReference(item.contentHash)) continue;
        try {
          await handle.provider.delete(item.remotePath);
        } catch (error) {
          if (!(error instanceof ProviderError && error.kind === 'not-found')) throw error;
        }
        this.deps.repo.settle(item.id);
        settled += 1;
        this.deps.audit(`PURGE-REMOTE-SETTLED item=${String(item.id)}`);
      } catch {
        this.deps.audit(`PURGE-REMOTE-PENDING item=${String(item.id)}`);
      }
    }
    return { settled, pending: this.deps.repo.pending().length };
  }
}
