import assert from 'node:assert/strict';
import { test } from 'node:test';

import Database from 'better-sqlite3-multiple-ciphers';

import { MIGRATIONS, migrate } from '../../src/main/db/migrations.js';
import { queryAll, queryGet, run } from '../../src/main/db/sql.js';
import { loadVectorExtension } from '../../src/main/db/vector-extension.js';

test('migration v20 creates custody provenance on fresh libraries and preserves v18 offloaded rows as legacy-unbound (#729)', () => {
  const db = new Database(':memory:');
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version <= 18),
  );
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'key', '2026-07-25T00:00:00.000Z')`);
  run(
    db,
    `INSERT INTO photos (
       id, file_name, file_kind, width, height, bytes, content_hash, imported_at, import_source, key_id
     ) VALUES ('P1', 'p1.jpg', 'jpeg', 1, 1, 23, '${'a'.repeat(64)}', '2026-07-25T00:00:00.000Z', 'test', 1)`,
  );
  run(db, `INSERT INTO sync_ledger (photo_id, status, dirty) VALUES ('P1', 'offloaded', 0)`);

  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version <= 20),
  );

  const columns = queryAll<{ name: string }>(db, 'PRAGMA table_info(sync_ledger)').map(({ name }) => name);
  assert.ok(columns.includes('custody_authority_id'));
  assert.equal(
    queryGet<{ custodyAuthorityId: number | null }>(
      db,
      'SELECT custody_authority_id AS custodyAuthorityId FROM sync_ledger WHERE photo_id = ?',
      'P1',
    )?.custodyAuthorityId,
    null,
  );
  assert.equal(queryGet<{ version: number }>(db, 'SELECT max(version) AS version FROM schema_migrations')?.version, 20);

  migrate(db);
  assert.equal(
    queryGet<{ name: string }>(db, `SELECT name FROM sqlite_master WHERE name = 'photo_embedding_vectors'`)?.name,
    undefined,
    'the portable migration does not require a native vec0 module',
  );
  loadVectorExtension(db);
  assert.equal(
    queryGet<{ version: number }>(db, 'SELECT max(version) AS version FROM schema_migrations')?.version,
    Math.max(...MIGRATIONS.map(({ version }) => version)),
  );
  db.close();
});
