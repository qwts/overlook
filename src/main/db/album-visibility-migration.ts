import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

// Migration 028 — collection visibility in All Photos (#494, ADR-0030 §2/§6/§7).
// `albums.show_in_all_photos` is the per-collection policy; `photos.in_all_photos`
// is the transactional composition flag (true when a photo has no membership
// or at least one containing album is visible). Both default to visible, so
// every existing row and every future import starts in the gallery (§7).
export function migrateAlbumVisibility(db: BetterSqlite3.Database): void {
  db.exec(`
    ALTER TABLE albums ADD COLUMN show_in_all_photos INTEGER NOT NULL DEFAULT 1
      CHECK (show_in_all_photos IN (0, 1));
    ALTER TABLE photos ADD COLUMN in_all_photos INTEGER NOT NULL DEFAULT 1
      CHECK (in_all_photos IN (0, 1));
    -- Composition is evaluated per photo across its memberships; the PK only
    -- serves album-first lookups.
    CREATE INDEX idx_album_photos_photo ON album_photos (photo_id, album_id);
    -- Rows hidden by album policy are the minority; the partial index keeps
    -- the disclosure count and the rebuild sweep off the full table.
    CREATE INDEX idx_photos_hidden_by_albums ON photos (id) WHERE in_all_photos = 0;
  `);
}
