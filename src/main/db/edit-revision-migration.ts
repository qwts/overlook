import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

// Edit revisions (#493, ADR-0031 §2 + §8). Each row is one immutable revision
// document stored as canonical JSON exactly as written, so a reader that
// cannot evaluate it (a newer format, an unknown operation) preserves it and
// fails closed instead of rewriting it. `photos.edit_head` names the current
// revision; NULL is the empty root revision every existing photo starts with,
// so the migration is metadata-only and legacy derivatives stay valid (§8).
// Purge cascades through the foreign key (the death list, §8).
export function migrateEditRevisions(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE edit_revisions (
      id TEXT PRIMARY KEY,
      photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES edit_revisions(id),
      document TEXT NOT NULL CHECK (json_valid(document)),
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX edit_revisions_photo ON edit_revisions(photo_id, created_at);
    ALTER TABLE photos ADD COLUMN edit_head TEXT REFERENCES edit_revisions(id);
  `);
}

/** Device-local debt: an edit head is durable before its derivatives can bake. */
export function migrateEditBakeDebt(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE photo_edit_bake_debt (
      photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
      head_revision_id TEXT NOT NULL
    );
    CREATE TRIGGER photos_edit_bake_debt AFTER UPDATE OF edit_head ON photos
      WHEN NEW.edit_head IS NOT OLD.edit_head AND NEW.edit_head IS NOT NULL
    BEGIN
      INSERT INTO photo_edit_bake_debt (photo_id, head_revision_id)
      VALUES (NEW.id, NEW.edit_head)
      ON CONFLICT(photo_id) DO UPDATE SET head_revision_id = excluded.head_revision_id;
    END;
    -- Older saves did not record whether their bake succeeded. Rebuild once;
    -- authenticating an existing preview cannot establish its edit revision.
    INSERT INTO photo_edit_bake_debt (photo_id, head_revision_id)
      SELECT id, edit_head FROM photos WHERE edit_head IS NOT NULL;
  `);
}
