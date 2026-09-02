import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import Database from 'better-sqlite3-multiple-ciphers';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { migrate, MIGRATIONS } from '../../src/main/db/migrations.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { queryAll, queryGet, run } from '../../src/main/db/sql.js';
import { VariantRepository, variantDerivativeKey } from '../../src/main/db/variant-repository.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #496 / ADR-0031 §1, §3, §8: several photos rows may reference one original
// asset. Schema 33 rebuilds the photos table without the UNIQUE content hash
// it was born with — same rows, same rowids, children and triggers intact —
// and gives every row a derivative key (its content hash) so no legacy
// derivative moves. Duplicate copies a row as a starting point; Promote is
// reversible metadata; both are plain library data.

const HASH = 'a'.repeat(64);
const NOW = '2026-09-02T10:00:00.000Z';

function photo(id: string, overrides: Partial<PhotoInsert> = {}): PhotoInsert {
  return {
    id,
    fileName: 'IMG_0001.JPG',
    fileKind: 'jpeg',
    width: 30,
    height: 20,
    bytes: 4242,
    contentHash: HASH,
    camera: 'FUJIFILM X-T5',
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focalLength: null,
    takenAt: null,
    gpsLat: null,
    gpsLon: null,
    place: 'Kyoto',
    importedAt: '2026-07-14T21:00:00.000Z',
    importSource: 'camera',
    keyId: 1,
    ...overrides,
  };
}

function open(): { db: Database.Database; repo: PhotosRepository; variants: VariantRepository } {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-variants-')), 'library.db'),
    dbKey: Buffer.alloc(32, 7),
  });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-14T20:00:00.000Z')`);
  return { db, repo: new PhotosRepository(db), variants: new VariantRepository(db) };
}

function names(db: Database.Database, type: 'index' | 'trigger'): string[] {
  return queryAll<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type = @type AND tbl_name = 'photos' AND sql IS NOT NULL ORDER BY name`,
    { type },
  ).map((row) => row.name);
}

describe('schema 33 — the photos rebuild (#496)', () => {
  test('rows, rowids, children, indexes, triggers, and the search index survive; every row gets its hash as derivative key', () => {
    const db = new Database(join(mkdtempSync(join(tmpdir(), 'overlook-variants-rebuild-')), 'library.db'));
    db.pragma('foreign_keys = ON');
    migrate(
      db,
      MIGRATIONS.filter((migration) => migration.version < 33),
    );
    run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-14T20:00:00.000Z')`);
    const insert = (id: string, hash: string): void => {
      run(
        db,
        `INSERT INTO photos (id, file_name, file_kind, width, height, bytes, content_hash, imported_at, import_source, key_id)
         VALUES (?, 'IMG_0001.JPG', 'jpeg', 30, 20, 42, ?, '2026-07-14T21:00:00.000Z', 'camera', 1)`,
        id,
        hash,
      );
      run(db, `INSERT INTO sync_ledger (photo_id, status, dirty) VALUES (?, 'local', 1)`, id);
    };
    insert('P1', HASH);
    insert('P2', 'b'.repeat(64));
    run(db, `INSERT INTO albums (id, name, created_at, position) VALUES ('A1', 'Trip', '2026-07-14T21:00:00.000Z', 0)`);
    run(db, `INSERT INTO album_photos (album_id, photo_id, position) VALUES ('A1', 'P1', 0)`);
    assert.throws(() => insert('P3', HASH), /UNIQUE/u, 'pre-33: one row per hash');
    const rowidsBefore = queryAll<{ id: string; rowid: number }>(db, `SELECT id, rowid FROM photos ORDER BY id`);
    const indexesBefore = names(db, 'index');
    const triggersBefore = names(db, 'trigger');

    assert.equal(migrate(db, MIGRATIONS), 1);

    assert.deepEqual(queryAll<{ id: string; rowid: number }>(db, `SELECT id, rowid FROM photos ORDER BY id`), rowidsBefore);
    assert.deepEqual(queryAll<{ id: string; key: string }>(db, `SELECT id, derivative_key AS key FROM photos ORDER BY id`), [
      { id: 'P1', key: HASH },
      { id: 'P2', key: 'b'.repeat(64) },
    ]);
    assert.equal(queryGet<{ n: number }>(db, `SELECT count(*) AS n FROM album_photos`)?.n, 1, 'child rows were not cascaded away');
    assert.equal(queryGet<{ n: number }>(db, `SELECT count(*) AS n FROM sync_ledger`)?.n, 2);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'the guard restored foreign keys');
    for (const name of indexesBefore) assert.ok(names(db, 'index').includes(name), `index ${name} recreated`);
    assert.deepEqual(names(db, 'trigger'), triggersBefore);
    assert.ok(names(db, 'index').includes('photos_derivative_key'));
    // External-content FTS: the rebuilt index agrees with the rebuilt table,
    // and the recreated triggers keep it that way.
    db.exec(`INSERT INTO photos_fts(photos_fts, rank) VALUES ('integrity-check', 1)`);
    insert('P3', HASH);
    run(db, `UPDATE photos SET derivative_key = ? WHERE id = 'P3'`, variantDerivativeKey('P3', HASH));
    db.exec(`INSERT INTO photos_fts(photos_fts, rank) VALUES ('integrity-check', 1)`);
    assert.equal(
      queryGet<{ n: number }>(db, `SELECT count(*) AS n FROM photos WHERE content_hash = ?`, HASH)?.n,
      2,
      'two variants on one hash',
    );
    // Cascades still work after the rebuild.
    run(db, `DELETE FROM photos WHERE id = 'P1'`);
    assert.equal(queryGet<{ n: number }>(db, `SELECT count(*) AS n FROM album_photos`)?.n, 0);
    db.close();
  });

  test('the derivative key, not the content hash, is the unique address', () => {
    const { db, repo } = open();
    repo.insert(photo('P1'));
    repo.insert(photo('P2', { derivativeKey: variantDerivativeKey('P2', HASH), variantSourceId: 'P1' }));
    assert.throws(() => repo.insert(photo('P3')), /UNIQUE/u, 'a second root on the same hash collides on the key');
    assert.equal(repo.countAnyByContentHash(HASH), 2);
    assert.equal(repo.get('P2')?.variantSourceId, 'P1');
    assert.equal(repo.get('P1')?.derivativeKey, HASH);
    assert.equal(repo.stats().bytes, 4242, 'a shared original counts once');
    assert.notEqual(variantDerivativeKey('P2', HASH), variantDerivativeKey('P3', HASH));
    assert.match(variantDerivativeKey('P2', HASH), /^[a-f0-9]{64}$/u);
    db.close();
  });
});

describe('VariantRepository (#496)', () => {
  test('Duplicate copies the row as a starting point, seats it in the same albums, and leaves the marks behind', () => {
    const { db, repo, variants } = open();
    repo.insert(photo('P1'));
    repo.toggleFavorite('P1');
    run(db, `UPDATE photos SET is_original = 1, edit_head = NULL WHERE id = 'P1'`);
    repo.createAlbum('A1', 'Trip');
    repo.addToAlbum('A1', ['P1']);
    run(
      db,
      `INSERT INTO photo_provenance (photo_id, subject_hash, evaluator, evaluated_at, tier, evidence)
       VALUES ('P1', ?, 'test/1', ?, 'unknown', '{}')`,
      HASH,
      NOW,
    );
    const source = repo.get('P1');
    assert.ok(source);

    variants.duplicate(source, 'P2', NOW);

    const variant = repo.get('P2');
    assert.ok(variant);
    assert.equal(variant.contentHash, HASH);
    assert.equal(variant.derivativeKey, variantDerivativeKey('P2', HASH));
    assert.equal(variant.variantSourceId, 'P1');
    assert.equal(variant.assetOwnerId, 'P1', 'the original’s envelope binds the importing row');
    assert.equal(source.assetOwnerId, null, 'a root is its own owner');
    variants.duplicate(variant, 'P3', NOW);
    assert.equal(repo.get('P3')?.assetOwnerId, 'P1', 'a duplicate of a duplicate keeps the root owner');
    assert.equal(repo.get('P3')?.variantSourceId, 'P2');
    assert.equal(variant.fileName, source.fileName);
    assert.equal(variant.camera, source.camera);
    assert.equal(variant.importedAt, NOW);
    assert.equal(variant.favorite, false);
    assert.equal(variant.isOriginal, false);
    assert.equal(variant.deletedAt, null);
    assert.equal(variant.syncState, 'local');
    assert.deepEqual(
      queryAll<{ album_id: string; position: number }>(db, `SELECT album_id, position FROM album_photos WHERE photo_id = 'P2'`),
      [{ album_id: 'A1', position: 1 }],
    );
    assert.equal(queryGet<{ dirty: number }>(db, `SELECT dirty FROM sync_ledger WHERE photo_id = 'P2'`)?.dirty, 1);
    assert.equal(queryGet<{ n: number }>(db, `SELECT count(*) AS n FROM photo_provenance WHERE photo_id = 'P2'`)?.n, 1);
    assert.equal(repo.countAnyByContentHash(HASH), 3);
    db.close();
  });

  test('a family is every live variant on the hash; Promote is reversible and dies with its row', () => {
    const { db, repo, variants } = open();
    repo.insert(photo('P1'));
    const source = repo.get('P1');
    assert.ok(source);
    variants.duplicate(source, 'P2', NOW);
    variants.duplicate(source, 'P3', '2026-09-02T11:00:00.000Z');
    repo.softDelete(['P3']);

    let family = variants.family(HASH);
    assert.deepEqual(
      family.variants.map((row) => row.id),
      ['P1', 'P2'],
      'trashed variants are not shown; order is import order',
    );
    assert.equal(family.representativeId, null);
    assert.equal(variants.liveCount(HASH), 2);
    assert.deepEqual(variants.familiesSnapshot(), [], 'families without a representative are not recorded');

    variants.promote(HASH, 'P2');
    family = variants.family(HASH);
    assert.equal(family.representativeId, 'P2');
    assert.deepEqual(variants.familiesSnapshot(), [{ contentHash: HASH, representativeId: 'P2' }]);
    variants.promote(HASH, 'P1');
    assert.equal(variants.representative(HASH), 'P1');

    repo.softDelete(['P1']);
    repo.purgeRow('P1');
    assert.equal(variants.representative(HASH), null, 'ON DELETE SET NULL');
    assert.deepEqual(variants.familiesSnapshot(), []);
    variants.restoreFamilies([{ contentHash: HASH, representativeId: 'P2' }]);
    assert.equal(variants.representative(HASH), 'P2');
    db.close();
  });
});
