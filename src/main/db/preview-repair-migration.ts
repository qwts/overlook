import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

/** Local derivative debt survives crashes without changing the backup contract. */
export function migratePreviewRepairDebt(db: BetterSqlite3.Database): void {
  db.exec(`
    ALTER TABLE photos ADD COLUMN preview_repair_pending INTEGER NOT NULL DEFAULT 0
      CHECK (preview_repair_pending IN (0, 1));
    CREATE INDEX idx_photos_preview_repair ON photos (content_hash, id)
      WHERE preview_repair_pending = 1;
    -- Older duplicates may already lack previews. The repair pass authenticates
    -- existing derivatives before deciding whether a bake is necessary.
    UPDATE photos SET preview_repair_pending = 1
      WHERE derivative_key <> content_hash AND file_kind IN ('jpeg', 'png', 'raw', 'heic', 'gif', 'webp');
  `);
}
