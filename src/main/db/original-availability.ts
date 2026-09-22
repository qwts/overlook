import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll, run } from './sql.js';

/** Device-local evidence, independent of previews and transient upload errors. */
export function migrateOriginalAvailability(db: BetterSqlite3.Database): void {
  db.exec(`
    ALTER TABLE photos ADD COLUMN original_failure TEXT
      CHECK (original_failure IS NULL OR original_failure = 'missing-original');
    DROP INDEX idx_photos_unavailable;
    CREATE INDEX idx_photos_unavailable ON photos (id)
      WHERE preview_failure IS NOT NULL OR preview_missing = 1 OR dimension_status = 'unavailable' OR original_failure IS NOT NULL;
  `);
}

export class OriginalAvailabilityRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  /** Only consistency repair may pair absence evidence with its ledger repair. */
  repair(photoId: string, status: 'offloaded' | 'error'): void {
    this.db.transaction(() => {
      run(this.db, 'UPDATE photos SET original_failure = ? WHERE id = ?', status === 'error' ? 'missing-original' : null, photoId);
      run(this.db, 'UPDATE sync_ledger SET status = ? WHERE photo_id = ?', status, photoId);
    })();
  }

  /** Call only after authenticated, content-address-verified publication. A file
   * existing, or a preview decoding, is not evidence that the original returned. */
  verifiedRestored(contentHash: string): readonly string[] {
    return queryAll<{ id: string }>(
      this.db,
      'UPDATE photos SET original_failure = NULL WHERE content_hash = @contentHash AND original_failure IS NOT NULL RETURNING id',
      { contentHash },
    ).map((row) => row.id);
  }
}

/** Composition callback for successful authenticated original publication. */
export function createOriginalRecoveryNotification(
  db: BetterSqlite3.Database,
  changed: (event: { photoIds: string[]; membership: 'library' }) => void,
): (contentHash: string) => void {
  const availability = new OriginalAvailabilityRepository(db);
  return (hash) => {
    const photoIds = availability.verifiedRestored(hash);
    if (photoIds.length > 0) changed({ photoIds: [...photoIds], membership: 'library' });
  };
}
