import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

export function migratePurgeCleanup(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE purge_remote_cleanup (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      photo_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('original', 'sidecar')),
      remote_path TEXT NOT NULL,
      authority_id INTEGER NOT NULL REFERENCES custody_authorities(id),
      UNIQUE(photo_id, remote_path, authority_id)
    );
  `);
}
