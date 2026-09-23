import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

/** Recovery can replace an original without replacing its derivative envelopes.
 * Keep their prior custody conservatively until the owning photo is purged. */
export function migrateRetainedPhotoKeys(db: BetterSqlite3.Database): void {
  db.exec(`CREATE TABLE retained_photo_keys (
    photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    key_id INTEGER NOT NULL REFERENCES keys(id),
    PRIMARY KEY (photo_id, key_id)
  );
  CREATE INDEX idx_retained_photo_keys_key ON retained_photo_keys(key_id, photo_id);`);
}

/** Photo queries bind p to the photo and k to its original's key. */
export const PHOTO_KEY_PRESENT_SQL = `CASE WHEN EXISTS (
  SELECT 1 FROM retained_photo_keys r JOIN keys rk ON rk.id = r.key_id
  WHERE r.photo_id = p.id AND rk.material_present = 0
) THEN 0 ELSE k.material_present END`;

/** Name one absent required key; importing it lets the next read expose any
 * remaining missing key without confusing it with the current write key. */
export const PHOTO_MISSING_KEY_SQL = `CASE WHEN k.material_present = 0 THEN p.key_id ELSE (
  SELECT MIN(r.key_id) FROM retained_photo_keys r JOIN keys rk ON rk.id = r.key_id
  WHERE r.photo_id = p.id AND rk.material_present = 0
) END`;
