import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

// Migration 029 — album folders and organizational tags (#505, ADR-0030 §1).
// `albums` is the collection table: `kind` separates folders from albums,
// `parent_id` may only name a folder (enforced in the repository, inside the
// transaction that writes a move, together with cycle and depth checks), and
// `inherits_visibility` marks a collection whose All Photos policy follows
// its folder (§2) — the effective policy stays materialized in
// `show_in_all_photos` so the §6 flag expression never walks ancestors.
// Existing albums stay root-level with their own policy (§7).
//
// Organizational tags live in their own vocabulary with no identifier shared
// with photo keywords: a join between the two is impossible by schema, not
// by convention.
export function migrateAlbumFolders(db: BetterSqlite3.Database): void {
  db.exec(`
    ALTER TABLE albums ADD COLUMN kind TEXT NOT NULL DEFAULT 'album' CHECK (kind IN ('album', 'folder'));
    ALTER TABLE albums ADD COLUMN parent_id TEXT REFERENCES albums(id);
    ALTER TABLE albums ADD COLUMN inherits_visibility INTEGER NOT NULL DEFAULT 0
      CHECK (inherits_visibility IN (0, 1));
    CREATE INDEX idx_albums_parent ON albums (parent_id, position);
    CREATE TABLE album_tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE album_tag_links (
      album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES album_tags(id) ON DELETE CASCADE,
      PRIMARY KEY (album_id, tag_id)
    );
  `);
}
