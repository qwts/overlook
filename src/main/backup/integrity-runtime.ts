import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { BlobStore } from '../blobs/blob-store.js';
import type { KeyResolver } from '../crypto/envelope.js';
import type { PhotosRepository } from '../db/photos-repository.js';
import { BackupIntegrityCursorStore } from './integrity-cursor.js';
import {
  BackupIntegrityScrubber,
  verifyRemoteOriginalCiphertext,
  type BackupIntegrityScrubberDeps,
  type BackupIntegritySummary,
} from './integrity-scrubber.js';
import type { StorageProvider } from './provider.js';
import type { CustodyAuthority, CustodyAuthorityRepository } from './custody-authority-repository.js';
import { CustodyResolutionError, type CustodyHandleResolver } from './custody-handle.js';

interface BackupIntegrityRuntimeDeps {
  readonly db: BetterSqlite3.Database;
  readonly provider: StorageProvider;
  readonly authorities: Pick<CustodyAuthorityRepository, 'legacyUnboundCount' | 'offloadedAuthorities'>;
  readonly custody: Pick<CustodyHandleResolver, 'resolveAuthority'>;
  readonly repo: Pick<PhotosRepository, 'integrityItems'>;
  readonly blobs: Pick<BlobStore, 'hasOriginal' | 'getEncryptedStream'>;
  readonly resolveKey: KeyResolver;
  readonly markUnrecoverable: (photoId: string) => void;
  readonly audit: (line: string) => void;
  readonly legacyAuthority?:
    (() => Promise<{ readonly authority: CustodyAuthority; readonly provider: StorageProvider } | null>) | undefined;
  readonly bindLegacyPhoto?: ((photoId: string, authorityId: number) => boolean) | undefined;
  readonly custodyChanged?: (() => void) | undefined;
}

/** Composition seam kept outside index.ts so the Electron root stays below
 * the repository's enforced file-size ceiling. */
export interface BackupIntegrityRuntime {
  readonly scrub: () => Promise<BackupIntegritySummary>;
}

function scrubber(
  deps: BackupIntegrityRuntimeDeps,
  provider: StorageProvider,
  cursorScope: string | (() => string),
  items: BackupIntegrityScrubberDeps['items'],
  markVerified?: (photoId: string) => void,
): BackupIntegrityScrubber {
  return new BackupIntegrityScrubber({
    provider,
    batchSize: 50,
    items,
    hasLocal: (hash) => deps.blobs.hasOriginal(hash),
    encryptedStream: (hash) => deps.blobs.getEncryptedStream(hash),
    verifyRemoteCiphertext: (item, ciphertext) => verifyRemoteOriginalCiphertext(item, ciphertext, deps.resolveKey),
    markUnrecoverable: deps.markUnrecoverable,
    ...(markVerified === undefined ? {} : { markVerified }),
    cursor: new BackupIntegrityCursorStore(deps.db, cursorScope),
    audit: deps.audit,
    now: () => new Date(),
  });
}

export function createBackupIntegrityRuntime(deps: BackupIntegrityRuntimeDeps): BackupIntegrityRuntime {
  const target = scrubber(
    deps,
    deps.provider,
    () => deps.provider.id,
    (page) => deps.repo.integrityItems(page, { syncState: 'synced' }),
  );
  return {
    scrub: async () => {
      const summaries: BackupIntegritySummary[] = [await target.scrub()];
      let allAuthoritiesReachable = true;
      // Legacy lookup may perform the first post-upgrade namespace proof and
      // stage existing authorities fail-closed, so it precedes all custody IO.
      const legacy = await deps.legacyAuthority?.();
      for (const authority of deps.authorities.offloadedAuthorities()) {
        let provider: StorageProvider;
        try {
          provider = (await deps.custody.resolveAuthority(authority)).provider;
        } catch (error) {
          allAuthoritiesReachable = false;
          const reason = error instanceof CustodyResolutionError ? error.reason : 'custody-unavailable';
          deps.audit(`INTEGRITY-CUSTODY-SKIP authority=${String(authority.id)} reason=${reason}`);
          continue;
        }
        summaries.push(
          await scrubber(deps, provider, `custody-authority:${String(authority.id)}`, (page) =>
            deps.repo.integrityItems(page, { syncState: 'offloaded', custodyAuthorityId: authority.id }),
          ).scrub(),
        );
      }
      if (legacy !== undefined && legacy !== null && deps.bindLegacyPhoto !== undefined) {
        let changed = false;
        summaries.push(
          await scrubber(
            deps,
            legacy.provider,
            `legacy-custody:${String(legacy.authority.id)}`,
            (page) => deps.repo.integrityItems(page, { legacyUnbound: true }),
            (photoId) => {
              changed = deps.bindLegacyPhoto?.(photoId, legacy.authority.id) === true || changed;
            },
          ).scrub(),
        );
        if (changed) deps.custodyChanged?.();
      } else if (deps.authorities.legacyUnboundCount().items > 0) {
        allAuthoritiesReachable = false;
        deps.audit('INTEGRITY-CUSTODY-SKIP authority=legacy-unbound reason=custody-unavailable');
      }
      return summaries.reduce<BackupIntegritySummary>(
        (total, summary) => ({
          checked: total.checked + summary.checked,
          repaired: total.repaired + summary.repaired,
          unrecoverable: total.unrecoverable + summary.unrecoverable,
          cycleComplete: total.cycleComplete && summary.cycleComplete,
        }),
        { checked: 0, repaired: 0, unrecoverable: 0, cycleComplete: allAuthoritiesReachable },
      );
    },
  };
}
