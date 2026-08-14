import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { buildBackupManifestV6, parseBackupManifest, type BackupManifestSidecarV6 } from '../../src/main/backup/backup-manifest.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// Schema-6 manifests (#484, ADR-0031 §7): every encrypted companion is listed
// with its ciphertext digest so restore can verify downloads byte-for-byte.

const LIB_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const PHOTO_ID = '01BRZ3NDEKTSV4RRFFQ69G5FAB';

function openSeeded() {
  const db = openLibraryDatabase({ path: join(mkdtempSync(join(tmpdir(), 'overlook-sm-')), 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'w', ?)`, '2026-07-01T00:00:00Z');
  const repo = new PhotosRepository(db);
  repo.insert({
    id: PHOTO_ID,
    fileName: 'IMG_1.jpg',
    fileKind: 'jpeg',
    width: 1,
    height: 1,
    bytes: 10,
    contentHash: 'a'.repeat(64),
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
  } satisfies PhotoInsert);
  return repo;
}

function sidecarObject(overrides: Partial<BackupManifestSidecarV6> = {}): BackupManifestSidecarV6 {
  return {
    photoId: PHOTO_ID,
    role: 'xmp',
    fileName: 'IMG_1.xmp',
    hash: 'c'.repeat(64),
    bytes: 64,
    keyId: 1,
    blobPath: `sidecars/${PHOTO_ID}/${'c'.repeat(64)}`,
    ciphertext: { sha256: 'd'.repeat(64), bytes: 128 },
    ...overrides,
  };
}

function snapshotWith(sidecars: readonly BackupManifestSidecarV6[]) {
  const base = openSeeded().manifestSnapshot();
  return { ...base, protectedAlbums: [], protectedPhotos: [], activity: [], boards: [], sidecars };
}

describe('schema-6 sidecar manifests (#484)', () => {
  test('a V6 manifest carries companion objects and round-trips through parse', () => {
    const manifest = buildBackupManifestV6({
      libraryId: LIB_ID,
      generatedAt: '2026-07-29T00:00:00.000Z',
      snapshot: snapshotWith([sidecarObject()]),
    });
    assert.equal(manifest.schema, 6);
    const parsed = parseBackupManifest(JSON.parse(JSON.stringify(manifest)));
    assert.equal(parsed.restorable, true);
    assert.equal(parsed.restorable && parsed.manifest.schema, 6);
    assert.equal(
      parsed.restorable && parsed.manifest.schema === 6 ? parsed.manifest.sidecars[0]?.blobPath : null,
      `sidecars/${PHOTO_ID}/${'c'.repeat(64)}`,
    );
  });

  test('a sidecar referencing a photo outside the manifest is rejected', () => {
    assert.throws(
      () =>
        buildBackupManifestV6({
          libraryId: LIB_ID,
          generatedAt: '2026-07-29T00:00:00.000Z',
          snapshot: snapshotWith([sidecarObject({ photoId: LIB_ID, blobPath: `sidecars/${LIB_ID}/${'c'.repeat(64)}` })]),
        }),
      /photo not in the manifest/,
    );
  });

  test('a blobPath that does not derive from photoId + hash is rejected', () => {
    assert.throws(
      () =>
        buildBackupManifestV6({
          libraryId: LIB_ID,
          generatedAt: '2026-07-29T00:00:00.000Z',
          snapshot: snapshotWith([sidecarObject({ blobPath: 'sidecars/somewhere/else' })]),
        }),
      /blobPath must derive/,
    );
  });

  test('duplicate companion objects are rejected', () => {
    assert.throws(
      () =>
        buildBackupManifestV6({
          libraryId: LIB_ID,
          generatedAt: '2026-07-29T00:00:00.000Z',
          snapshot: snapshotWith([sidecarObject(), sidecarObject()]),
        }),
      /duplicate sidecar/,
    );
  });
});
