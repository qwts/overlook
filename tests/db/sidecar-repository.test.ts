import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { SidecarRepository, type SidecarRecord } from '../../src/main/db/sidecar-repository.js';
import { run } from '../../src/main/db/sql.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// photo_sidecars custody rows (#484, migration v23): idempotent insert,
// per-photo listing, CASCADE with the photo row.

const DB_KEY = randomBytes(32);
const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const ULID_B = '01BRZ3NDEKTSV4RRFFQ69G5FAB';

function photo(id: string, contentHash: string): PhotoInsert {
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
    importedAt: '2026-07-25T00:00:00.000Z',
    importSource: 'test',
    keyId: 1,
  };
}

function sidecar(photoId: string, hash: string, fileName = 'IMG_1.xmp'): SidecarRecord {
  return {
    photoId,
    role: 'xmp',
    fileName,
    contentHash: hash,
    bytes: 64,
    keyId: 1,
    importedAt: '2026-07-29T00:00:00.000Z',
  };
}

function openSeeded(): { db: ReturnType<typeof openLibraryDatabase>; repo: PhotosRepository; sidecars: SidecarRepository } {
  const db = openLibraryDatabase({ path: join(mkdtempSync(join(tmpdir(), 'overlook-sidecar-db-')), 'library.db'), dbKey: DB_KEY });
  run(db, `INSERT OR IGNORE INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-25T00:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  repo.insert(photo(ULID_A, 'a'.repeat(64)));
  repo.insert(photo(ULID_B, 'b'.repeat(64)));
  return { db, repo, sidecars: new SidecarRepository(db) };
}

describe('sidecar repository (#484, schema v23)', () => {
  test('insert is idempotent per (photo, content); listing is per photo and ordered', () => {
    const { sidecars } = openSeeded();
    sidecars.insert(sidecar(ULID_A, 'c'.repeat(64), 'IMG_1.xmp'));
    sidecars.insert(sidecar(ULID_A, 'c'.repeat(64), 'IMG_1.xmp'));
    sidecars.insert(sidecar(ULID_A, 'd'.repeat(64), 'IMG_1.aae'));
    sidecars.insert(sidecar(ULID_B, 'c'.repeat(64), 'IMG_2.xmp'));

    assert.deepEqual(
      sidecars.listForPhoto(ULID_A).map((row) => row.fileName),
      ['IMG_1.aae', 'IMG_1.xmp'],
    );
    assert.equal(sidecars.allRows().length, 3);
    assert.equal(sidecars.hasRowsForPhoto(ULID_A), true);
    assert.equal(sidecars.hasRowsForPhoto('01CRZ3NDEKTSV4RRFFQ69G5FAC'), false);
    const row = sidecars.listForPhoto(ULID_B)[0];
    assert.ok(row);
    assert.equal(row.role, 'xmp');
    assert.equal(row.bytes, 64);
    assert.equal(row.keyId, 1);
  });

  test('rows CASCADE with the photo — purge takes companion custody rows with it', () => {
    const { repo, sidecars } = openSeeded();
    sidecars.insert(sidecar(ULID_A, 'c'.repeat(64)));
    repo.softDelete([ULID_A]);
    repo.purgeRow(ULID_A);
    assert.equal(sidecars.hasRowsForPhoto(ULID_A), false);
    assert.deepEqual(sidecars.allRows(), []);
  });
});
