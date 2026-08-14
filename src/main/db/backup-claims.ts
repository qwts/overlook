import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll } from './sql.js';
import { createManifestDebtStore } from '../backup/manifest-debt.js';
import type { BackupEngineDeps } from '../backup/backup-engine.js';

// Ordinary remote-copy claim worklists (#741), kept beside PhotosRepository
// but out of its file-size budget. Both feed the publication preflight and
// the provider-switch guard: rows whose ledger promises a remote copy the
// SELECTED provider must actually hold.

export interface OrdinaryClaimRow {
  readonly id: string;
  readonly contentHash: string;
  readonly status: 'synced' | 'offloaded' | 'error';
}

export interface OrdinaryClaimDetail {
  readonly id: string;
  readonly contentHash: string;
  readonly bytes: number;
  readonly fileName: string;
  readonly keyId: number;
  readonly status: 'synced' | 'offloaded';
  readonly deleted: boolean;
}

/** The backup engine's #741 deps in one bundle (composition-root seam):
 * preflight claim lookup, local-original presence, durable manifest debt. */
export function createBackupClaimDeps(
  db: BetterSqlite3.Database,
  blobs: { hasOriginal(contentHash: string): boolean },
): Pick<BackupEngineDeps, 'claimsForContentHashes' | 'hasLocalOriginal' | 'manifestDebt'> {
  return {
    claimsForContentHashes: (hashes) => claimsForContentHashes(db, hashes),
    hasLocalOriginal: (hash) => blobs.hasOriginal(hash),
    manifestDebt: createManifestDebtStore(db),
  };
}

/** Every ordinary remote-copy claim plus the stuck 'error' rows a wrong
 * provider's integrity pass may have produced — the provider-switch guard's
 * worklist. */
export function remoteClaims(db: BetterSqlite3.Database): readonly OrdinaryClaimRow[] {
  return queryAll<OrdinaryClaimRow>(
    db,
    `SELECT p.id, p.content_hash AS contentHash, l.status
       FROM ordinary_visible_photos p
       JOIN sync_ledger l ON l.photo_id = p.id
      WHERE l.status IN ('synced', 'offloaded', 'error')
      ORDER BY p.id`,
  );
}

/** Provider selection owns only locally recoverable synced rows. Offloaded
 * rows are routed by ADR-0028 custody authority; legacy-unbound rows remain
 * fail-closed until reconnect reconciliation proves them individually. */
export function providerSwitchClaims(db: BetterSqlite3.Database): readonly OrdinaryClaimRow[] {
  return remoteClaims(db).filter((claim) => claim.status === 'synced');
}

/** Rows whose remote-copy claim references one of `contentHashes`: the
 * manifest preflight's map from a missing remote blob back to the photos
 * that promise it, deleted-but-retained rows included. */
export function claimsForContentHashes(db: BetterSqlite3.Database, contentHashes: readonly string[]): readonly OrdinaryClaimDetail[] {
  interface Row extends Omit<OrdinaryClaimDetail, 'deleted'> {
    readonly deleted: number;
  }
  const results: Row[] = [];
  const unique = [...new Set(contentHashes)];
  for (let start = 0; start < unique.length; start += 500) {
    const chunk = unique.slice(start, start + 500);
    const params = Object.fromEntries(chunk.map((hash, index) => [`h${String(index)}`, hash]));
    results.push(
      ...queryAll<Row>(
        db,
        `SELECT p.id, p.content_hash AS contentHash, p.bytes, p.file_name AS fileName, p.key_id AS keyId,
                l.status, (p.deleted_at IS NOT NULL) AS deleted
           FROM ordinary_visible_photos p
           JOIN sync_ledger l ON l.photo_id = p.id
          WHERE l.status IN ('synced', 'offloaded')
            AND p.content_hash IN (${chunk.map((_, index) => `@h${String(index)}`).join(', ')})
          ORDER BY p.imported_at, p.id`,
        params,
      ),
    );
  }
  return results.map((row) => ({ ...row, deleted: row.deleted === 1 }));
}
