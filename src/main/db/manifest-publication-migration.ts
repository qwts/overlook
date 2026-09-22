import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

export function migratePendingManifestPublication(db: BetterSqlite3.Database): void {
  db.exec('ALTER TABLE backup_manifest_debt ADD COLUMN pending_mutation TEXT');
}
