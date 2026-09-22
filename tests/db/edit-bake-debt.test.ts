import { EditBakeDebtRepository } from '../../src/main/db/edit-bake-debt-repository.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

import { migrate, MIGRATIONS } from '../../src/main/db/migrations.js';
import { EditRevisionRepository } from '../../src/main/db/edit-revision-repository.js';
import { queryGet, run } from '../../src/main/db/sql.js';
import { EDIT_AUTHOR_PRODUCT, EDIT_REVISION_FORMAT_VERSION, type EditRevisionDocument } from '../../src/shared/library/edit-revision.js';

const revision = (id: string, parentId: string | null): EditRevisionDocument => ({
  version: EDIT_REVISION_FORMAT_VERSION,
  id,
  parentId,
  operations: [{ type: 'rotate', version: 1, quarterTurns: 1 }],
  author: { product: EDIT_AUTHOR_PRODUCT, version: 'test' },
  createdAt: '2026-09-22T00:00:00.000Z',
  importedFrom: null,
});

test('edit bake debt backfills old heads and only settles the current revision, transactionally (#1115)', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrate(
      db,
      MIGRATIONS.filter((entry) => entry.version < 44),
    );
    assert.equal(queryGet<{ version: number }>(db, 'SELECT max(version) AS version FROM schema_migrations')?.version, 43);
    assert.ok(queryGet(db, "SELECT name FROM pragma_table_info('backup_manifest_debt') WHERE name = 'pending_mutation'"));
    run(db, "INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-09-22')");
    for (const id of ['edited', 'unedited']) {
      run(
        db,
        `INSERT INTO photos (id, file_name, file_kind, width, height, bytes, content_hash, derivative_key,
        imported_at, import_source, key_id) VALUES (?, ?, 'jpeg', 60, 40, 42, ?, ?, '2026-09-22', 'test', 1)`,
        id,
        `${id}.jpg`,
        id,
        id,
      );
    }
    run(db, "INSERT INTO sync_ledger (photo_id, status, dirty) VALUES ('edited', 'synced', 0)");
    const revisions = new EditRevisionRepository(db);
    const old = '01J8EDT000000000000000000A';
    const next = '01J8EDT000000000000000000B';
    const rolledBack = '01J8EDT000000000000000000C';
    revisions.append('edited', revision(old, null));
    migrate(db);
    assert.equal(queryGet<{ version: number }>(db, 'SELECT max(version) AS version FROM schema_migrations')?.version, 44);
    const debt = new EditBakeDebtRepository(db);
    assert.equal(debt.pending('edited'), old, 'legacy edited previews have no trusted bake identity');
    assert.equal(debt.pending('unedited'), undefined);
    revisions.append('edited', revision(next, old));
    assert.equal(debt.pending('edited'), next);
    assert.equal(debt.settle('edited', old), false, 'older completion cannot clear newer debt');
    assert.equal(debt.settle('edited', next), true);
    assert.equal(debt.pending('edited'), undefined);
    assert.equal(
      queryGet<{ dirty: number }>(db, "SELECT dirty FROM sync_ledger WHERE photo_id = 'edited'")?.dirty,
      0,
      'local derivative repairs do not re-upload unchanged originals',
    );
    assert.throws(
      db.transaction(() => {
        revisions.append('edited', revision(rolledBack, next));
        throw new Error('rollback');
      }),
      /rollback/u,
    );
    assert.equal(revisions.head('edited').head?.id, next);
    assert.equal(debt.pending('edited'), undefined, 'head and debt roll back together');
    revisions.append('edited', revision(rolledBack, next));
    run(db, "DELETE FROM photos WHERE id = 'edited'");
    assert.equal(queryGet(db, "SELECT 1 FROM photo_edit_bake_debt WHERE photo_id = 'edited'"), undefined, 'purge cascades local debt');
  } finally {
    db.close();
  }
});
