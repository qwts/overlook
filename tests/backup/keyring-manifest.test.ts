import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  buildBackupManifestV15,
  parseBackupManifest,
  type BackupManifestSnapshotV15,
} from '../../src/main/backup/backup-manifest.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { KeyringRepository } from '../../src/main/db/keyring-repository.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import type { WrappedKeyRecord } from '../../src/main/crypto/keystore.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #517 / ADR-0032 §2: schema 15 carries the keyring registry so a restored
// library keeps every key's (key_ref, version) identity, the parser refuses
// a manifest whose photos name a key the registry lacks, and a restore whose
// bootstrap is missing a key yields locked rows rather than a refusal.

const LIBRARY = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const AT = '2026-09-02T00:00:00.000Z';
const REF_1 = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const REF_2 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const KEY_1: WrappedKeyRecord = {
  id: 1,
  wrappedKey: 'test',
  createdAt: AT,
  status: 'active',
  keyRef: REF_1,
  version: 1,
  kind: 'library',
  origin: 'local',
};

function photo(id: string, keyId: number, hashByte: string): PhotoInsert {
  return {
    id,
    fileName: `${id}.JPG`,
    fileKind: 'jpeg',
    width: 30,
    height: 20,
    bytes: 42,
    contentHash: hashByte.repeat(64),
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

function open(seeded: boolean) {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-keyring-manifest-')), 'library.db'),
    dbKey: randomBytes(32),
  });
  const keyring = new KeyringRepository(db);
  const photos = new PhotosRepository(db);
  if (seeded) {
    const facts = { version: 1, kind: 'library' as const, origin: 'local' as const, createdAt: AT, present: true };
    keyring.register([
      { id: 1, keyRef: REF_1, fingerprint: 'AAAA·BBBB·CCCC·DDDD', retiredAt: '2026-09-01T00:00:00.000Z', ...facts },
      { id: 2, keyRef: REF_2, fingerprint: null, retiredAt: null, ...facts },
    ]);
    keyring.setLabel(2, 'Studio laptop');
    photos.insert(photo('P1', 1, 'a'));
    photos.insert(photo('P2', 2, 'b'));
  }
  return { db, keyring, photos };
}

function snapshotOf(photos: PhotosRepository): BackupManifestSnapshotV15 {
  return {
    ...photos.manifestSnapshot(),
    protectedAlbums: [],
    protectedPhotos: [],
    activity: [],
    boards: [],
    sidecars: [],
    galleryPolicy: photos.galleryPolicy(),
    hiddenAlbumIds: [],
    folders: [],
    albumTree: [],
    smartAlbums: [],
    editRevisions: [],
    provenance: [],
    variantFamilies: [],
  };
}

describe('the keyring in the manifest (#517, schema 15)', () => {
  test('the snapshot carries every registry row and the manifest parses as schema 15', () => {
    assert.equal(BACKUP_MANIFEST_SCHEMA_VERSION, 15);
    const { photos } = open(true);
    const manifest = buildBackupManifestV15({ libraryId: LIBRARY, generatedAt: AT, snapshot: snapshotOf(photos) });
    assert.equal(manifest.schema, 15);
    assert.deepEqual(manifest.keyring, [
      { keyId: 1, keyRef: REF_1, version: 1, kind: 'library', origin: 'local', label: null, fingerprint: 'AAAA·BBBB·CCCC·DDDD' },
      { keyId: 2, keyRef: REF_2, version: 1, kind: 'library', origin: 'local', label: 'Studio laptop', fingerprint: null },
    ]);
    const parsed = parseBackupManifest(JSON.parse(JSON.stringify(manifest)));
    assert.ok(parsed.restorable);
    assert.equal(parsed.manifest.schema, 15);
  });

  test('the parser refuses a photo whose key the registry lacks and a registry with a duplicated identity', () => {
    const { photos } = open(true);
    const manifest = buildBackupManifestV15({ libraryId: LIBRARY, generatedAt: AT, snapshot: snapshotOf(photos) });
    const json = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
    assert.throws(() => parseBackupManifest({ ...json, keyring: json.keyring.slice(0, 1) }), /schema-15|keyring|key/u);
    assert.throws(
      () => parseBackupManifest({ ...json, keyring: [...json.keyring, { ...json.keyring[1], keyId: 3 }] }),
      /schema-15|keyring|reference/u,
    );
    assert.throws(
      () => parseBackupManifest({ ...json, keyring: [...json.keyring, { ...json.keyring[1], keyRef: 'c'.repeat(32) }] }),
      /schema-15|keyring|id/u,
    );
  });

  test('restore keeps the registry identity and marks a key the bootstrap lacks as absent, so its photos read as locked', () => {
    const source = open(true);
    const manifest = buildBackupManifestV15({ libraryId: LIBRARY, generatedAt: AT, snapshot: snapshotOf(source.photos) });
    const target = open(false);
    target.photos.restoreManifest(manifest, [KEY_1]);
    assert.deepEqual(
      target.keyring.list().map((row) => [row.id, row.keyRef, row.label, row.present, row.active]),
      [
        [1, REF_1, null, true, true],
        [2, REF_2, 'Studio laptop', false, false],
      ],
      'presence and activity come from the recovered custody, identity and label from the manifest',
    );
    assert.equal(target.photos.get('P1')?.locked, false);
    assert.equal(target.photos.get('P2')?.locked, true);
    assert.deepEqual(target.keyring.lockedIds(), [2]);
  });
});
