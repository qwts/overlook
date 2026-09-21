import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Database from 'better-sqlite3-multiple-ciphers';

import { migrate, MIGRATIONS } from '../../src/main/db/migrations.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { SidecarRepository } from '../../src/main/db/sidecar-repository.js';
import { queryGet, run } from '../../src/main/db/sql.js';
import { VariantRepository } from '../../src/main/db/variant-repository.js';

const HASH = 'a'.repeat(64);
const SIDECAR_HASH = 'b'.repeat(64);
const NOW = '2026-09-21T00:00:00.000Z';

function legacy(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 40),
  );
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', ?)`, NOW);
  for (const [id, owner, derivative] of [
    ['root', null, HASH],
    ['sibling', 'root', 'c'.repeat(64)],
    ['unrelated', null, 'd'.repeat(64)],
  ]) {
    run(
      db,
      `INSERT INTO photos
      (id, file_name, file_kind, width, height, bytes, content_hash, imported_at, import_source, key_id, derivative_key, asset_owner_id)
      VALUES (?, 'photo.jpg', 'jpeg', 1, 1, 12, ?, ?, 'test', 1, ?, ?)`,
      id,
      HASH,
      NOW,
      derivative,
      owner,
    );
    run(db, `INSERT INTO sync_ledger (photo_id, status, dirty) VALUES (?, 'synced', 0)`, id);
  }
  run(
    db,
    `INSERT INTO photo_sidecars (photo_id, role, file_name, content_hash, bytes, key_id, imported_at)
    VALUES ('root', 'xmp', 'photo.xmp', ?, 42, 1, ?)`,
    SIDECAR_HASH,
    NOW,
  );
  return db;
}

describe('shared companion references (#1120)', () => {
  test('migration retains ciphertext identity and fills only the same asset family', () => {
    const db = legacy();
    try {
      migrate(db);
      const sidecars = new SidecarRepository(db);
      const root = sidecars.listForPhoto('root')[0];
      assert.ok(root);
      assert.equal(root.ownerId, 'root');
      assert.deepEqual(sidecars.listForPhoto('sibling'), [{ ...root, photoId: 'sibling' }]);
      assert.deepEqual(sidecars.listForPhoto('unrelated'), [], 'same plaintext hash alone does not prove shared custody');
      assert.equal(queryGet<{ dirty: number }>(db, `SELECT dirty FROM sync_ledger WHERE photo_id = 'sibling'`)?.dirty, 1);
      assert.equal(queryGet<{ dirty: number }>(db, `SELECT dirty FROM sync_ledger WHERE photo_id = 'unrelated'`)?.dirty, 0);
      assert.equal(migrate(db), 0, 'migration is recorded and does not replay');
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    } finally {
      db.close();
    }
  });

  test('duplicate of a duplicate preserves the import owner after both ancestors are purged', () => {
    const db = legacy();
    try {
      migrate(db);
      const photos = new PhotosRepository(db);
      const sidecars = new SidecarRepository(db);
      const variants = new VariantRepository(db);
      const source = photos.get('sibling');
      assert.ok(source);
      variants.duplicate(source, 'grandchild', NOW);
      const expected = sidecars.listForPhoto('sibling').map((row) => ({ ...row, photoId: 'grandchild' }));
      photos.softDelete(['root', 'sibling']);
      photos.purgeRow('root');
      photos.purgeRow('sibling');
      assert.deepEqual(sidecars.listForPhoto('grandchild'), expected);
      assert.equal(expected[0]?.ownerId, 'root');
      assert.deepEqual(sidecars.listForPhoto('root'), []);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    } finally {
      db.close();
    }
  });
});
