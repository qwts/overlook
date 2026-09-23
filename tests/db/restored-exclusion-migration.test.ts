import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import { MIGRATIONS, migrate } from '../../src/main/db/migrations.js';
import { queryGet, run } from '../../src/main/db/sql.js';

test('restored-exclusion migration never infers provenance from legacy local-only errors (#1125)', () => {
  const db = new Database(':memory:');
  try {
    migrate(
      db,
      MIGRATIONS.filter(({ version }) => version < 47),
    );
    run(db, "INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'key', '2026-09-22')");
    run(
      db,
      `INSERT INTO photos (
      id, file_name, file_kind, width, height, bytes, content_hash, imported_at, import_source, key_id, original_failure
    ) VALUES ('legacy', 'local.jpg', 'jpeg', 1, 1, 23, '${'a'.repeat(64)}', '2026-09-22', 'test', 1, 'missing-original')`,
    );
    run(db, "INSERT INTO sync_ledger (photo_id, status, coverage, dirty) VALUES ('legacy', 'error', 'excluded', 0)");
    migrate(db);
    assert.equal(
      queryGet<{ origin: string | null }>(db, "SELECT restored_exclusion_at AS origin FROM photos WHERE id = 'legacy'")?.origin,
      null,
    );
    assert.equal(migrate(db), 0, 'migration remains idempotent');
  } finally {
    db.close();
  }
});
