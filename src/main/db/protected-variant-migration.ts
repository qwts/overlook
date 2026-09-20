import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

/** Source identities survive the ordinary-row deletion at commit (#1118).
 * Existing pre-commit journals can recover them from their still-owned row;
 * legacy journals without a row retain the former root-photo defaults. */
export function migrateProtectedVariantSources(db: BetterSqlite3.Database): void {
  db.exec(`
    ALTER TABLE protected_photo_migration_items ADD COLUMN source_asset_owner_id TEXT;
    ALTER TABLE protected_photo_migration_items ADD COLUMN source_derivative_ref TEXT;
    UPDATE protected_photo_migration_items
       SET source_asset_owner_id = (
             SELECT coalesce(p.asset_owner_id, p.id) FROM photos p WHERE p.id = photo_id
           ),
           source_derivative_ref = (
             SELECT p.derivative_key FROM photos p WHERE p.id = photo_id
           )
     WHERE migration_id IN (SELECT migration_id FROM protected_photo_migrations WHERE operation = 'protect');
  `);
}
