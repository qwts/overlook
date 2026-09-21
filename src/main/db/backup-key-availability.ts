import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll } from './sql.js';

/** Queries using this predicate bind the owning photos row as p. Original
 * and companion custody jointly determine whether backup may touch a photo. */
export const PHOTO_HAS_ABSENT_KEY_SQL = `EXISTS (SELECT 1 FROM keys k WHERE k.id = p.key_id AND k.material_present = 0)
  OR EXISTS (SELECT 1 FROM photo_sidecars s JOIN keys k ON k.id = s.key_id
    WHERE s.photo_id = p.id AND k.material_present = 0)`;

export function unavailableKeyIdsForPhoto(db: BetterSqlite3.Database, photoId: string): readonly number[] {
  return queryAll<{ id: number }>(
    db,
    `SELECT k.id FROM photos p JOIN keys k ON k.id = p.key_id
    WHERE p.id = @id AND k.material_present = 0
    UNION SELECT k.id FROM photo_sidecars s JOIN keys k ON k.id = s.key_id
    WHERE s.photo_id = @id AND k.material_present = 0 ORDER BY id`,
    { id: photoId },
  ).map((row) => row.id);
}
