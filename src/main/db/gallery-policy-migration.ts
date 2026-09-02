import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

// Migration 027 — All Photos inclusion rules (#512, ADR-0030 §4/§5). One
// encrypted row so the policy travels with the library and its backup;
// defaults match the ADR: unavailable rows visible, no size floor.
export function migrateGalleryPolicy(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE gallery_policy (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      show_unavailable INTEGER NOT NULL DEFAULT 1 CHECK (show_unavailable IN (0, 1)),
      minimum_megapixels REAL CHECK (minimum_megapixels IS NULL OR minimum_megapixels > 0),
      updated_at TEXT NOT NULL
    );
    INSERT INTO gallery_policy (id, show_unavailable, minimum_megapixels, updated_at)
      VALUES (1, 1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    -- The derived Unavailable source and the hide-unavailable rule both
    -- select over these two columns; a partial index keeps their count and
    -- page walk off the full table at 200K rows.
    CREATE INDEX idx_photos_unavailable ON photos (id)
      WHERE preview_failure IS NOT NULL OR dimension_status = 'unavailable';
  `);
}
