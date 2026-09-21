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

/** Audit worklist in one SQL walk, not one synchronous query per dirty row. */
export function lockedDirtyPhotos(db: BetterSqlite3.Database): readonly { id: string; keyIds: readonly number[] }[] {
  const rows = queryAll<{ photoId: string; keyId: number }>(
    db,
    `WITH dirty AS (
    SELECT p.id, p.key_id FROM ordinary_visible_photos p JOIN sync_ledger l ON l.photo_id = p.id
    WHERE l.dirty = 1 AND l.coverage = 'included' AND p.deleted_at IS NULL
  )
  SELECT d.id AS photoId, k.id AS keyId FROM dirty d JOIN keys k ON k.id = d.key_id WHERE k.material_present = 0
  UNION
  SELECT d.id AS photoId, k.id AS keyId FROM dirty d JOIN photo_sidecars s ON s.photo_id = d.id
    JOIN keys k ON k.id = s.key_id WHERE k.material_present = 0
  ORDER BY photoId, keyId`,
  );
  const grouped = new Map<string, number[]>();
  for (const row of rows) {
    const ids = grouped.get(row.photoId) ?? [];
    ids.push(row.keyId);
    grouped.set(row.photoId, ids);
  }
  return [...grouped].map(([id, keyIds]) => ({ id, keyIds }));
}
