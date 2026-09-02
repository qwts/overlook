import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll, queryGet } from './sql.js';

// Variants (#496, ADR-0031 §1, §3, §8). A variant is a photos row that
// references an original asset by content hash; several rows may share one
// hash, so the UNIQUE constraint the schema was born with has to go. SQLite
// cannot drop a column constraint, so the table is rebuilt: same columns,
// same rowids (the external-content FTS index keys on them), indexes and
// triggers recreated verbatim. Two columns arrive with the rebuild —
// `derivative_key`, the address the thumb/mid derivatives live under (equal
// to the content hash for every existing row, so legacy derivatives stay
// valid without regeneration), and `variant_source_id`, the variant this
// one was duplicated from, and `asset_owner_id`, the photo whose import
// sealed the original's envelope (its AAD binds that id; null means this
// row). `variant_families` carries Promote (§3). No plaintext is read and
// no blob is rewritten (§8).
//
// The runner turns foreign keys off around this migration (a DROP TABLE with
// them on would cascade every child row away) and checks them before commit.

const UNIQUE_MARKER = 'content_hash TEXT NOT NULL UNIQUE';
const REBUILT_TABLE = 'photos_variants';

export function migrateVariants(db: BetterSqlite3.Database): void {
  const table = queryGet<{ sql: string }>(db, `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'photos'`);
  if (table === undefined) throw new Error('variants migration: photos table is missing');
  if (!table.sql.includes(UNIQUE_MARKER)) throw new Error('variants migration: photos.content_hash is not the expected UNIQUE column');
  if (!/^CREATE TABLE "?photos"?\s*\(/u.test(table.sql)) throw new Error('variants migration: unexpected photos DDL');
  const rebuilt = table.sql
    .replace(/^CREATE TABLE "?photos"?/u, `CREATE TABLE ${REBUILT_TABLE}`)
    .replace(UNIQUE_MARKER, 'content_hash TEXT NOT NULL');
  const columns = queryAll<{ name: string }>(db, `PRAGMA table_info(photos)`).map((column) => `"${column.name}"`);
  const indexes = queryAll<{ sql: string }>(
    db,
    `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'photos' AND sql IS NOT NULL ORDER BY name`,
  );
  const triggers = queryAll<{ sql: string }>(
    db,
    `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'photos' ORDER BY name`,
  );

  db.exec(rebuilt);
  db.exec(`ALTER TABLE ${REBUILT_TABLE} ADD COLUMN derivative_key TEXT NOT NULL DEFAULT ''`);
  db.exec(`ALTER TABLE ${REBUILT_TABLE} ADD COLUMN variant_source_id TEXT`);
  db.exec(`ALTER TABLE ${REBUILT_TABLE} ADD COLUMN asset_owner_id TEXT`);
  const list = ['rowid', ...columns].join(', ');
  db.exec(`INSERT INTO ${REBUILT_TABLE} (${list}) SELECT ${list} FROM photos`);
  db.exec(`UPDATE ${REBUILT_TABLE} SET derivative_key = content_hash`);
  db.exec(`DROP TABLE photos`);
  // Legacy rename: views and triggers that name `photos` keep their text
  // instead of being rewritten (or rejected) while the table is absent.
  db.pragma('legacy_alter_table = ON');
  try {
    db.exec(`ALTER TABLE ${REBUILT_TABLE} RENAME TO photos`);
  } finally {
    db.pragma('legacy_alter_table = OFF');
  }
  for (const index of indexes) db.exec(index.sql);
  for (const trigger of triggers) db.exec(trigger.sql);
  db.exec(`
    CREATE UNIQUE INDEX photos_derivative_key ON photos(derivative_key);
    CREATE INDEX photos_content_hash ON photos(content_hash);
    CREATE TABLE variant_families (
      content_hash TEXT PRIMARY KEY,
      representative_id TEXT REFERENCES photos(id) ON DELETE SET NULL
    );
    INSERT INTO photos_fts(photos_fts) VALUES ('rebuild');
  `);
  const count = queryGet<{ n: number }>(db, `SELECT count(*) AS n FROM photos WHERE derivative_key = ''`)?.n ?? 0;
  if (count !== 0) throw new Error('variants migration: derivative keys were not assigned');
}
