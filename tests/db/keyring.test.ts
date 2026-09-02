import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { KeyringRepository, type KeyringRegistration } from '../../src/main/db/keyring-repository.js';
import { MIGRATIONS } from '../../src/main/db/migrations.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { queryGet, run } from '../../src/main/db/sql.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #517 / ADR-0032 §2: the keys table becomes the keyring registry — every
// row names a (key_ref, version) identity, its kind and origin, and whether
// this device holds the material; a photo whose key is absent reads as
// locked from the same query that lists it.

const AT = '2026-09-02T00:00:00.000Z';
const REF_1 = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const REF_2 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function photo(id: string, keyId: number, bytes: number): PhotoInsert {
  return {
    id,
    fileName: `${id}.JPG`,
    fileKind: 'jpeg',
    width: 30,
    height: 20,
    bytes,
    contentHash: id.repeat(8).slice(0, 64).padEnd(64, '0'),
    camera: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focalLength: null,
    takenAt: null,
    gpsLat: null,
    gpsLon: null,
    place: null,
    importedAt: AT,
    importSource: 'camera',
    favorite: false,
    keyId,
  };
}

function registration(id: number, keyRef: string, overrides: Partial<KeyringRegistration> = {}): KeyringRegistration {
  return {
    id,
    keyRef,
    version: 1,
    kind: 'library',
    origin: 'local',
    fingerprint: null,
    createdAt: AT,
    retiredAt: null,
    present: true,
    ...overrides,
  };
}

function open() {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-keyring-db-')), 'library.db'),
    dbKey: randomBytes(32),
  });
  return { db, keyring: new KeyringRepository(db), photos: new PhotosRepository(db) };
}

describe('keyring registry (#517, migration 36)', () => {
  test('migration 36 heads the chain, mints a reference for legacy rows, and enforces the registry constraints', () => {
    assert.deepEqual(
      MIGRATIONS.slice(-1).map((migration) => ({ version: migration.version, name: migration.name })),
      [{ version: 36, name: 'library-keyring' }],
    );
    const { db } = open();
    run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', ?)`, AT);
    const row = queryGet<{ key_ref: string; version: number; kind: string; origin: string; material_present: number; wrap_scheme: string }>(
      db,
      `SELECT key_ref, version, kind, origin, material_present, wrap_scheme FROM keys WHERE id = 1`,
    );
    assert.ok(row);
    assert.match(row.key_ref, /^[0-9a-f]{32}$/u, 'a legacy insert gets a minted reference');
    assert.deepEqual(
      [row.version, row.kind, row.origin, row.material_present, row.wrap_scheme],
      [1, 'library', 'local', 1, 'master-aes-256-gcm'],
    );
    assert.throws(
      () => run(db, `INSERT INTO keys (id, wrapped_key, created_at, key_ref) VALUES (2, 'test', ?, ?)`, AT, row.key_ref),
      /UNIQUE/u,
      'one (reference, version) identity per row',
    );
    assert.throws(() => run(db, `INSERT INTO keys (id, wrapped_key, created_at, kind) VALUES (3, 'test', ?, 'bogus')`, AT), /CHECK/u);
    assert.throws(() => run(db, `INSERT INTO keys (id, wrapped_key, created_at, key_ref) VALUES (4, 'test', ?, 'NOT-HEX')`, AT), /CHECK/u);
  });

  test('register upserts the facts, keeps the first retirement, never overwrites a label, and byRef finds the row', () => {
    const { db, keyring } = open();
    keyring.register([registration(1, REF_1, { fingerprint: 'AAAA·BBBB·CCCC·DDDD' })]);
    keyring.setLabel(1, 'Studio');
    keyring.register([registration(1, REF_1, { retiredAt: '2026-09-01T00:00:00.000Z' })]);
    keyring.register([registration(1, REF_1, { retiredAt: '2026-09-02T00:00:00.000Z' })]);
    const row = keyring.get(1);
    assert.ok(row);
    assert.equal(row.label, 'Studio');
    assert.equal(row.fingerprint, 'AAAA·BBBB·CCCC·DDDD', 'a null fingerprint never erases a known one');
    assert.equal(row.active, false);
    assert.equal(queryGet<{ retired_at: string }>(db, `SELECT retired_at FROM keys WHERE id = 1`)?.retired_at, '2026-09-01T00:00:00.000Z');
    keyring.register([registration(1, REF_1)]);
    assert.equal(keyring.get(1)?.active, true, 'a null retirement reactivates the row');
    assert.equal(keyring.byRef(REF_1, 1)?.id, 1);
    assert.equal(keyring.byRef(REF_1, 2), undefined);
  });

  test('usage counts photos including the trash, and an absent key locks exactly its rows', () => {
    const { db, keyring, photos } = open();
    keyring.register([registration(1, REF_1), registration(2, REF_2, { retiredAt: AT })]);
    photos.insert(photo('P1', 1, 42));
    photos.insert(photo('P2', 2, 58));
    photos.insert(photo('P3', 2, 10));
    photos.softDelete(['P3']);
    assert.deepEqual(keyring.usage(2), { photos: 2, sidecars: 0, bytes: 68 });
    assert.deepEqual([...keyring.photoIds(2)].sort(), ['P2', 'P3']);
    assert.deepEqual(keyring.lockedIds(), []);

    keyring.setPresent(2, false);
    assert.deepEqual(keyring.lockedIds(), [2], 'the absent key ids, for the open-time locked report');
    assert.equal(photos.get('P2')?.locked, true);
    assert.equal(photos.get('P1')?.locked, false);
    assert.deepEqual(
      photos.records(['P1', 'P2']).map((record) => [record.id, record.locked]),
      [
        ['P1', false],
        ['P2', true],
      ],
    );
    assert.equal(keyring.list().find((row) => row.id === 2)?.present, false);

    keyring.setPresent(2, true);
    keyring.markAbsentExcept([1]);
    assert.equal(keyring.get(2)?.present, false, 'custody the store no longer holds is marked absent');
    assert.equal(queryGet<{ n: number }>(db, `SELECT count(*) AS n FROM keys WHERE material_present = 1`)?.n, 1);
  });
});
