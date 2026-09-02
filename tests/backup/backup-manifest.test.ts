import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  BackupManifestError,
  backupManifestV3Schema,
  backupManifestV2Schema,
  parseBackupManifest,
  type BackupManifestV2,
} from '../../src/main/backup/backup-manifest.js';

const HASH = 'ab'.repeat(32);

function manifest(): BackupManifestV2 {
  return {
    schema: 2,
    libraryId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
    databaseSchema: 3,
    generatedAt: '2026-07-14T23:00:00.000Z',
    keyIds: [1],
    totals: { photos: 1, bytes: 42, albums: 1 },
    photos: [
      {
        id: 'P1',
        fileName: 'IMG_0001.JPG',
        fileKind: 'jpeg',
        mediaInfo: null,
        width: 10,
        height: 20,
        bytes: 42,
        contentHash: HASH,
        blobPath: `blobs/ab/${HASH}`,
        camera: 'Camera',
        lens: null,
        iso: 100,
        aperture: 'f/2.8',
        shutter: '1/125',
        focalLength: 35,
        takenAt: '2026-07-14T22:00:00.000Z',
        gpsLat: 41.88,
        gpsLon: -87.63,
        place: 'Chicago',
        importedAt: '2026-07-14T22:30:00.000Z',
        importSource: 'camera',
        favorite: true,
        keyId: 1,
        deletedAt: null,
      },
    ],
    albums: [
      {
        id: 'A1',
        name: 'Favorites',
        createdAt: '2026-07-14T22:45:00.000Z',
        position: 0,
        photoIds: ['P1'],
      },
    ],
  };
}

describe('backup manifest schema (#289)', () => {
  test('schema 2 round-trips complete recoverable photo and album state', () => {
    const source = manifest();
    assert.deepEqual(backupManifestV2Schema.parse(JSON.parse(JSON.stringify(source))), source);
    assert.deepEqual(parseBackupManifest(source), { restorable: true, manifest: source });
  });

  test('schema 1 remains parseable but is explicitly not fully restorable', () => {
    const legacy = {
      schema: 1 as const,
      rows: [{ id: 'P1', contentHash: HASH, bytes: 42, fileName: 'IMG_0001.JPG', keyId: 1 }],
    };
    assert.deepEqual(parseBackupManifest(legacy), { restorable: false, manifest: legacy });
  });

  test('cross-record inconsistencies fail validation', () => {
    const source = manifest();
    assert.throws(
      () =>
        parseBackupManifest({
          ...source,
          keyIds: [2],
          totals: { ...source.totals, bytes: 41 },
          albums: [{ ...source.albums[0], photoIds: ['missing'] }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof BackupManifestError);
        assert.match(error.message, /photo key is missing/u);
        assert.match(error.message, /byte total does not match/u);
        assert.match(error.message, /album member is missing/u);
        return true;
      },
    );
  });

  test('blob references are derived from the content hash, never arbitrary provider paths', () => {
    const source = manifest();
    assert.throws(
      () => parseBackupManifest({ ...source, photos: [{ ...source.photos[0], blobPath: '../escape' }] }),
      /blob path does not match/u,
    );
  });

  test('timestamps and album ordering are canonical', () => {
    const source = manifest();
    assert.throws(() => parseBackupManifest({ ...source, generatedAt: 'next Tuesday' }), /Invalid ISO datetime/u);
    assert.throws(
      () =>
        parseBackupManifest({
          ...source,
          totals: { ...source.totals, albums: 2 },
          albums: [...source.albums, { ...source.albums[0], id: 'A2' }],
        }),
      /album positions must be unique/u,
    );
  });

  test('photo capture time accepts the persisted floating EXIF format', () => {
    const source = manifest();
    const floatingTakenAt = '2026-06-12T12:34:56';
    const parsed = parseBackupManifest({
      ...source,
      photos: [{ ...source.photos[0], takenAt: floatingTakenAt }],
    });
    assert.equal(parsed.restorable, true);
    if (!parsed.restorable) assert.fail('schema 2 manifest must be restorable');
    assert.equal(parsed.manifest.photos[0]?.takenAt, floatingTakenAt);
    assert.throws(
      () => parseBackupManifest({ ...source, photos: [{ ...source.photos[0], takenAt: '2026-06-12 12:34:56' }] }),
      /Invalid ISO datetime/u,
    );
  });

  test('schema 3 preserves sealed protected records behind opaque provider paths', () => {
    const ordinary = manifest();
    const blobRef = 'cd'.repeat(32);
    const source = {
      ...ordinary,
      schema: 3 as const,
      protectedAlbums: [
        {
          id: 'secret-album-id',
          credentialGeneration: 1,
          metadataGeneration: 1,
          credentialRecord: Buffer.from('credential').toString('base64'),
          sealedMetadata: Buffer.from('album metadata').toString('base64'),
          createdAt: ordinary.generatedAt,
          updatedAt: ordinary.generatedAt,
        },
      ],
      protectedPhotos: [
        {
          id: 'secret-photo-id',
          albumId: 'secret-album-id',
          blobRef,
          sealedMetadata: Buffer.from('photo metadata').toString('base64'),
          createdAt: ordinary.generatedAt,
          updatedAt: ordinary.generatedAt,
          objects: [
            {
              kind: 'original' as const,
              path: `protected/cd/${blobRef}.original`,
              sha256: 'ef'.repeat(32),
              bytes: 99,
              status: 'synced' as const,
            },
          ],
        },
      ],
    };
    assert.deepEqual(backupManifestV3Schema.parse(source), source);
    assert.ok(!source.protectedPhotos[0]?.objects[0]?.path.includes('secret'));
  });

  test('schema 3 rejects protected membership and ciphertext claim inconsistencies', () => {
    const ordinary = manifest();
    assert.throws(
      () =>
        parseBackupManifest({
          ...ordinary,
          schema: 3,
          protectedAlbums: [],
          protectedPhotos: [
            {
              id: 'P',
              albumId: 'missing',
              blobRef: HASH,
              sealedMetadata: 'c2VhbGVk',
              createdAt: ordinary.generatedAt,
              updatedAt: ordinary.generatedAt,
              objects: [{ kind: 'original', path: '../leak', sha256: HASH, bytes: 1, status: 'synced' }],
            },
          ],
        }),
      /protected album is missing|protected object path does not match/u,
    );
  });

  test('unknown schemas fail closed', () => {
    assert.throws(() => parseBackupManifest({ schema: BACKUP_MANIFEST_SCHEMA_VERSION + 1 }), /unsupported manifest schema 8/u);
  });
});

describe('media info in manifests (ADR-0026, #547)', () => {
  test('pre-0026 manifests without mediaInfo parse with the key ABSENT (never inserted)', () => {
    // Sealed protected metadata is verified by exact re-stringification, so
    // parsing legacy JSON must not insert keys (PR #626 review).
    const source = manifest();
    const legacy = JSON.parse(JSON.stringify(source)) as { photos: Array<Record<string, unknown>> };
    delete legacy.photos[0]?.['mediaInfo'];
    const parsed = backupManifestV2Schema.parse(legacy);
    assert.equal('mediaInfo' in (parsed.photos[0] ?? {}), false);
  });

  test('parseBackupManifest upgrades legacy manifests: absent mediaInfo reaches restore consumers as null (#1009)', () => {
    // The schema preserves absence (above, for the sealed re-stringification
    // paths that share it); the manifest parse entry point is where legacy
    // shapes migrate to the current contract, in one place.
    const source = manifest();
    const legacy = JSON.parse(JSON.stringify(source)) as { photos: Array<Record<string, unknown>> };
    delete legacy.photos[0]?.['mediaInfo'];
    const parsed = parseBackupManifest(legacy);
    assert.equal(parsed.restorable, true);
    if (!parsed.restorable) assert.fail('schema 2 manifest must be restorable');
    const photo = parsed.manifest.photos[0];
    assert.ok(photo !== undefined);
    assert.equal('mediaInfo' in photo, true);
    assert.equal(photo.mediaInfo, null);
  });

  test('probed facts roundtrip; playability tiers have no field to hide in', () => {
    const source = manifest();
    const withMedia = {
      ...source,
      photos: [{ ...source.photos[0], fileKind: 'gif', mediaInfo: { animated: true, frameCount: 3, loopCount: 0 } }],
    };
    const parsed = backupManifestV2Schema.parse(JSON.parse(JSON.stringify(withMedia)));
    assert.deepEqual(parsed.photos[0]?.mediaInfo, { animated: true, frameCount: 3, loopCount: 0 });
    assert.throws(() =>
      backupManifestV2Schema.parse({
        ...source,
        photos: [{ ...source.photos[0], mediaInfo: { animated: true, frameCount: 3, loopCount: 0, playable: true } }],
      }),
    );
  });
});

describe('Original preservation metadata (#482)', () => {
  test('legacy manifests omit the field while marked Originals roundtrip', () => {
    const source = manifest();
    const legacy = backupManifestV2Schema.parse(JSON.parse(JSON.stringify(source)));
    assert.equal('isOriginal' in (legacy.photos[0] ?? {}), false);

    const marked = backupManifestV2Schema.parse({
      ...source,
      photos: [{ ...source.photos[0], isOriginal: true }],
    });
    assert.equal(marked.photos[0]?.isOriginal, true);
  });
});
