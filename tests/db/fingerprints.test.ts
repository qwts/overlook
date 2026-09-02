import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { FingerprintRepository } from '../../src/main/db/fingerprint-repository.js';
import { MIGRATIONS } from '../../src/main/db/migrations.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { queryGet, run } from '../../src/main/db/sql.js';
import { VariantRepository } from '../../src/main/db/variant-repository.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #650 fingerprint custody: freshness follows the algorithm version, the
// derivative key and the content hash; deferrals are fresh rows without a
// hash; explicit invalidation re-queues; the row dies with the photo.

const VERSION = 'dhash-9x8-test';
const HASHES = ['0000000000000001', '0000000000000002', '0000000000000003', '0000000000000004'] as const;

function open(): { repo: PhotosRepository; fingerprints: FingerprintRepository; db: ReturnType<typeof openLibraryDatabase> } {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-fingerprints-')), 'library.db'),
    dbKey: Buffer.alloc(32, 9),
  });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-14T20:00:00.000Z')`);
  return { db, repo: new PhotosRepository(db), fingerprints: new FingerprintRepository(db) };
}

function photo(id: string, contentHash = `hash-${id}`): PhotoInsert {
  return {
    id,
    fileName: `${id}.jpg`,
    fileKind: 'jpeg',
    width: 640,
    height: 480,
    bytes: 1024,
    contentHash,
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
    importedAt: `2026-07-25T00:00:0${id.slice(-1)}.000Z`,
    importSource: 'test',
    keyId: 1,
  };
}

describe('perceptual fingerprint repository (#650)', () => {
  test('migration 34 is the ledger head and creates the table beside the photo', () => {
    assert.equal(MIGRATIONS.at(-1)?.version, 34);
    const { db } = open();
    const row = queryGet<{ name: string }>(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'photo_fingerprints'`);
    assert.equal(row?.name, 'photo_fingerprints');
  });

  test('pending walks live ordinary photos without a fresh row, in import order', () => {
    const { repo, fingerprints } = open();
    repo.insert(photo('P1'));
    repo.insert(photo('P2'));
    repo.insert(photo('P3'));
    assert.deepEqual(
      fingerprints.pending(VERSION, 10).map((candidate) => candidate.photoId),
      ['P1', 'P2', 'P3'],
    );
    const first = fingerprints.pending(VERSION, 1)[0];
    assert.ok(first !== undefined);
    assert.equal(first.derivativeKey, 'hash-P1');
    assert.ok(fingerprints.put(first, VERSION, HASHES));
    assert.deepEqual(
      fingerprints.pending(VERSION, 10).map((candidate) => candidate.photoId),
      ['P2', 'P3'],
    );
    assert.deepEqual(fingerprints.status(VERSION), { total: 3, indexed: 1, deferred: 0, pending: 2 });
    assert.throws(() => fingerprints.pending(VERSION, 0), RangeError);
  });

  test('a deferral is a fresh row that keeps the photo out of the queue until invalidated', () => {
    const { repo, fingerprints } = open();
    repo.insert(photo('P1'));
    const candidate = fingerprints.pending(VERSION, 1)[0];
    assert.ok(candidate !== undefined);
    assert.ok(fingerprints.defer(candidate, VERSION, 'derivative-unavailable'));
    assert.deepEqual(fingerprints.pending(VERSION, 10), []);
    assert.deepEqual(fingerprints.status(VERSION), { total: 1, indexed: 0, deferred: 1, pending: 0 });
    assert.deepEqual(fingerprints.entries(VERSION), []);
    assert.equal(fingerprints.invalidate(['P1', 'ghost']), 1);
    assert.equal(fingerprints.pending(VERSION, 10).length, 1);
  });

  test('a rescan drops hashed and deferred rows alike, so a preview that became readable is retried', () => {
    const { repo, fingerprints } = open();
    repo.insert(photo('P1'));
    repo.insert(photo('P2'));
    const [first, second] = fingerprints.pending(VERSION, 2);
    assert.ok(first !== undefined && second !== undefined);
    assert.ok(fingerprints.put(first, VERSION, HASHES));
    assert.ok(fingerprints.defer(second, VERSION, 'undecodable'));
    assert.deepEqual(fingerprints.status(VERSION), { total: 2, indexed: 1, deferred: 1, pending: 0 });
    assert.equal(fingerprints.invalidateAll(), 2);
    assert.deepEqual(fingerprints.status(VERSION), { total: 2, indexed: 0, deferred: 0, pending: 2 });
    assert.deepEqual(
      fingerprints.pending(VERSION, 10).map((candidate) => candidate.photoId),
      ['P1', 'P2'],
    );
  });

  test('freshness follows the version, and rows of another version are dropped', () => {
    const { repo, fingerprints } = open();
    repo.insert(photo('P1'));
    const candidate = fingerprints.pending(VERSION, 1)[0];
    assert.ok(candidate !== undefined);
    fingerprints.put(candidate, 'older-algo', HASHES);
    assert.equal(fingerprints.pending(VERSION, 10).length, 1, 'an older algorithm is not fresh');
    assert.equal(fingerprints.entries(VERSION).length, 0);
    assert.equal(fingerprints.deleteOtherVersions(VERSION), 1);
    fingerprints.put(candidate, VERSION, HASHES);
    assert.equal(fingerprints.deleteOtherVersions(VERSION), 0);
  });

  test('entries carry the grouping inputs and exclude trashed rows; a stale candidate is refused', () => {
    const { repo, fingerprints } = open();
    repo.insert(photo('P1'));
    repo.insert(photo('P2'));
    repo.setOriginal(['P2'], true);
    for (const candidate of fingerprints.pending(VERSION, 10)) assert.ok(fingerprints.put(candidate, VERSION, HASHES));
    const entries = fingerprints.entries(VERSION);
    assert.deepEqual(
      entries.map((entry) => [entry.photoId, entry.contentHash, entry.variantSourceId, entry.isOriginal]),
      [
        ['P1', 'hash-P1', null, false],
        ['P2', 'hash-P2', null, true],
      ],
    );
    assert.deepEqual(entries[0]?.rotations, [...HASHES]);
    repo.softDelete(['P1']);
    assert.deepEqual(
      fingerprints.entries(VERSION).map((entry) => entry.photoId),
      ['P2'],
    );
    assert.equal(fingerprints.put({ photoId: 'P2', contentHash: 'moved', derivativeKey: 'hash-P2' }, VERSION, HASHES), false);
    assert.throws(
      () => fingerprints.put({ photoId: 'P2', contentHash: 'hash-P2', derivativeKey: 'hash-P2' }, VERSION, ['bad']),
      RangeError,
    );
  });

  test('a variant (#496) is indexed under its own derivative key and carries its lineage', () => {
    const { repo, fingerprints, db } = open();
    repo.insert(photo('root'));
    const variants = new VariantRepository(db);
    const root = repo.get('root');
    assert.ok(root !== undefined);
    variants.duplicate(root, 'sib', '2026-07-26T00:00:00.000Z');
    const candidates = fingerprints.pending(VERSION, 10);
    const sibling = candidates.find((candidate) => candidate.photoId === 'sib');
    assert.ok(sibling !== undefined);
    assert.notEqual(sibling.derivativeKey, 'hash-root');
    for (const candidate of candidates) fingerprints.put(candidate, VERSION, HASHES);
    const entry = fingerprints.entries(VERSION).find((row) => row.photoId === 'sib');
    assert.deepEqual([entry?.contentHash, entry?.variantSourceId], ['hash-root', 'root']);
  });

  test('the row dies with the photo', () => {
    const { repo, fingerprints, db } = open();
    repo.insert(photo('P1'));
    const candidate = fingerprints.pending(VERSION, 1)[0];
    assert.ok(candidate !== undefined);
    fingerprints.put(candidate, VERSION, HASHES);
    repo.softDelete(['P1']);
    repo.purgeRow('P1');
    assert.equal(queryGet<{ count: number }>(db, `SELECT count(*) AS count FROM photo_fingerprints`)?.count, 0);
  });
});
