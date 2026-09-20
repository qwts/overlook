import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';

import {
  openProtectedPhotoMetadata,
  ProtectedPhotoMetadataError,
  sealProtectedPhotoMetadata,
  type ProtectedPhotoMetadata,
} from '../../src/main/crypto/protected-photo-metadata.js';

const context = { libraryId: 'library-a', albumId: 'album-a', photoId: 'photo-a' };
const metadata: ProtectedPhotoMetadata = {
  version: 1,
  photo: {
    id: 'photo-a',
    fileName: 'secret.jpg',
    fileKind: 'jpeg',
    mediaInfo: null,
    width: 4000,
    height: 3000,
    bytes: 10,
    contentHash: 'a'.repeat(64),
    camera: 'camera',
    lens: null,
    iso: 100,
    aperture: '2.8',
    shutter: '1/250',
    focalLength: 35,
    takenAt: '2026-07-16T12:00:00.000Z',
    gpsLat: 1,
    gpsLon: 2,
    place: 'private place',
    importedAt: '2026-07-16T12:00:00.000Z',
    importSource: 'camera',
    favorite: true,
    deletedAt: null,
  },
  ordinaryMemberships: [{ albumId: 'ordinary-a', position: 3 }],
};

describe('protected photo metadata', () => {
  test('round-trips searchable fields and ordinary memberships only with album authority', () => {
    const albumKey = randomBytes(32);
    const sealed = sealProtectedPhotoMetadata(context, albumKey, metadata);
    assert.equal(sealed.includes(Buffer.from('private place')), false);
    assert.deepEqual(openProtectedPhotoMetadata(context, albumKey, sealed), metadata);
    assert.throws(() => openProtectedPhotoMetadata({ ...context, albumId: 'album-b' }, albumKey, sealed), ProtectedPhotoMetadataError);
    assert.throws(() => openProtectedPhotoMetadata(context, randomBytes(32), sealed), ProtectedPhotoMetadataError);
  });

  test('binds the photo id and rejects tampering', () => {
    const albumKey = randomBytes(32);
    const sealed = sealProtectedPhotoMetadata(context, albumKey, metadata);
    assert.throws(() => openProtectedPhotoMetadata({ ...context, photoId: 'photo-b' }, albumKey, sealed), ProtectedPhotoMetadataError);
    sealed[sealed.length - 1] = (sealed.at(-1) ?? 0) ^ 1;
    assert.throws(() => openProtectedPhotoMetadata(context, albumKey, sealed), ProtectedPhotoMetadataError);
  });
});

describe('pre-0026 sealed metadata (no mediaInfo key)', () => {
  test('legacy plaintext opens unchanged — parsing never inserts keys (PR #626 review)', () => {
    const albumKey = randomBytes(32);
    // The legacy shape: exactly the pre-0026 field set, no mediaInfo. With
    // mediaInfo optional (not defaulted), seal writes the same bytes legacy
    // code wrote, and open's exact re-stringification check still holds.
    const { mediaInfo: _mediaInfo, ...legacyPhoto } = metadata.photo;
    const legacy = { ...metadata, photo: legacyPhoto } as ProtectedPhotoMetadata;
    const sealed = sealProtectedPhotoMetadata(context, albumKey, legacy);
    const opened = openProtectedPhotoMetadata(context, albumKey, sealed);
    assert.equal('mediaInfo' in opened.photo, false, 'no key inserted into legacy metadata');
    assert.equal(opened.photo.fileName, 'secret.jpg');
  });
});

test('v2 seals edit history and rejects revisions owned by a different photo', () => {
  const albumKey = randomBytes(32);
  const revision = {
    id: 'r1',
    photoId: context.photoId,
    parentId: null,
    createdAt: '2026-09-20T12:00:00.000Z',
    document: { version: 1 },
    current: true,
  };
  const edited: ProtectedPhotoMetadata = { ...metadata, version: 2, editRevisions: [revision] };
  assert.deepEqual(openProtectedPhotoMetadata(context, albumKey, sealProtectedPhotoMetadata(context, albumKey, edited)), edited);
  assert.throws(
    () => sealProtectedPhotoMetadata(context, albumKey, { ...edited, editRevisions: [{ ...revision, photoId: 'other' }] }),
    /photo the manifest does not carry/u,
  );
});
