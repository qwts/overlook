import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll, queryGet, run, runNamed } from '../db/sql.js';

export interface PurgeCleanupItem {
  readonly id: number;
  readonly photoId: string;
  readonly contentHash: string;
  readonly kind: 'original' | 'sidecar';
  readonly remotePath: string;
  readonly authorityId: number;
}

interface ExclusionClaim {
  readonly contentHash: string;
  readonly coverage: string;
  readonly status: string;
  readonly dirty: number;
  readonly authorityId: number | null;
}

/** Cleanup debt outlives photo/ledger CASCADE. No secret or selected-provider
 * fallback is stored: every operation retains its explicit source authority. */
export class PurgeCleanupRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  needsAuthority(photoId: string): boolean {
    const row = this.exclusion(photoId);
    return row.status === 'synced' || row.status === 'offloaded' || (row.status === 'error' && row.dirty === 0);
  }

  /** The caller's row removal must use this same connection. Any queue or
   * custody failure rolls back both, retaining the original retry ledger. */
  transferAndPurge(photoId: string, authorityId: number | undefined, removeRow: () => void): number {
    return this.db.transaction(() => {
      const row = this.exclusion(photoId);
      // Capture may await account identity while integrity changes the row.
      // Revalidate remote-only legacy custody at the irreversible boundary.
      if (row.authorityId === null && (row.status === 'offloaded' || (row.status === 'error' && row.dirty === 0)))
        throw new Error('pending removal has an unverified source authority');
      let pending = 0;
      if (this.needsAuthority(photoId)) {
        if (authorityId === undefined) throw new Error('pending removal has no source authority');
        if (row.authorityId !== null && row.authorityId !== authorityId) throw new Error('source authority changed before purge');
        const paths: { kind: 'original' | 'sidecar'; path: string }[] = [];
        paths.push({ kind: 'original', path: `blobs/${row.contentHash.slice(0, 2)}/${row.contentHash}` });
        for (const sidecar of queryAll<{ hash: string }>(
          this.db,
          'SELECT DISTINCT content_hash AS hash FROM photo_sidecars WHERE photo_id = @photoId',
          { photoId },
        )) {
          paths.push({ kind: 'sidecar', path: `sidecars/${photoId}/${sidecar.hash}` });
        }
        for (const path of paths) {
          runNamed(
            this.db,
            `INSERT INTO purge_remote_cleanup (photo_id, content_hash, kind, remote_path, authority_id)
            VALUES (@photoId, @contentHash, @kind, @remotePath, @authorityId)`,
            {
              photoId,
              contentHash: row.contentHash,
              kind: path.kind,
              remotePath: path.path,
              authorityId,
            },
          );
        }
        pending = paths.length;
      }
      removeRow();
      return pending;
    })();
  }

  pending(): readonly PurgeCleanupItem[] {
    return queryAll<PurgeCleanupItem>(
      this.db,
      `SELECT id, photo_id AS photoId, content_hash AS contentHash,
      kind, remote_path AS remotePath, authority_id AS authorityId
      FROM purge_remote_cleanup ORDER BY id`,
    );
  }

  hasManifestDebt(): boolean {
    return this.pending().some((item) => item.kind === 'sidecar' || !this.hasIncludedReference(item.contentHash));
  }

  settle(id: number): void {
    run(this.db, 'DELETE FROM purge_remote_cleanup WHERE id = ?', id);
  }

  hasIncludedReference(hash: string): boolean {
    return (
      queryGet(
        this.db,
        `SELECT 1 FROM photos p JOIN sync_ledger l ON l.photo_id = p.id
      WHERE p.content_hash = ? AND l.coverage = 'included' LIMIT 1`,
        hash,
      ) !== undefined
    );
  }

  private exclusion(photoId: string): ExclusionClaim {
    const row = queryGet<ExclusionClaim>(
      this.db,
      `SELECT p.content_hash AS contentHash, l.coverage, l.status, l.dirty, l.custody_authority_id AS authorityId
      FROM ordinary_visible_photos p JOIN sync_ledger l ON l.photo_id = p.id WHERE p.id = ?`,
      photoId,
    );
    if (row?.coverage !== 'excluding') throw new Error('pending exclusion changed before purge');
    return row;
  }
}
