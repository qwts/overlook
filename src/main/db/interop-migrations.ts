import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

/** #545: acknowledge received ciphertext only after it is durable. The
 * short-lived capability and socket authority remain memory-only. */
export function migrateDurableLiveLocalObjects(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE interop_local_objects (
      operation_id TEXT NOT NULL,
      path TEXT NOT NULL,
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
      bytes INTEGER NOT NULL CHECK (bytes >= 0),
      ciphertext BLOB NOT NULL CHECK (length(ciphertext) = bytes),
      PRIMARY KEY (operation_id, path),
      FOREIGN KEY (operation_id) REFERENCES interop_transport_routes(operation_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX idx_interop_local_objects_operation
      ON interop_local_objects (operation_id, path);
  `);
}
