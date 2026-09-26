import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

/** Coverage alone cannot distinguish a restored placeholder from a local-only
 * photo. Never infer provenance for existing rows during migration. */
export function migrateRestoredExclusion(db: BetterSqlite3.Database): void {
  db.exec(`
    ALTER TABLE photos ADD COLUMN restored_exclusion_at TEXT;
    CREATE TRIGGER clear_restored_exclusion_after_recovery
    AFTER UPDATE OF original_failure ON photos
    WHEN NEW.original_failure IS NULL AND NEW.restored_exclusion_at IS NOT NULL
    BEGIN
      UPDATE photos SET restored_exclusion_at = NULL WHERE id = NEW.id;
    END;
  `);
}
