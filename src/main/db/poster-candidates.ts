import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { PhotoRecord } from '../../shared/library/types.js';
import { SELECT, toRecord, type PhotoRow } from './photos-repository.js';
import { queryAll } from './sql.js';

/** Video items that may still need a deterministic poster (ADR-0026 §6):
 * local-backed, non-deleted, oldest first; `hasPoster` filters those already
 * captured. Standalone (not a repo method, no Electron imports) so it stays
 * unit-testable and keeps the repository file lean. */
export function posterCaptureCandidates(db: BetterSqlite3.Database, photoIds?: readonly string[]): readonly PhotoRecord[] {
  return queryAll<PhotoRow>(
    db,
    `${SELECT} WHERE p.deleted_at IS NULL AND p.file_kind = 'video' AND COALESCE(l.status, 'local') <> 'offloaded'
       AND (@ids IS NULL OR p.id IN (SELECT value FROM json_each(@ids))) ORDER BY p.imported_at, p.id`,
    { ids: photoIds === undefined ? null : JSON.stringify(photoIds) },
  ).map(toRecord);
}
