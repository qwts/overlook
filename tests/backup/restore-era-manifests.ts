import type { KeyStore } from '../../src/main/crypto/keystore.js';
import {
  backupManifestV3Schema,
  buildBackupManifestV16,
  type BackupManifestSnapshotV7,
  type BackupManifestV16,
  backupManifestV4Schema,
  backupManifestV5Schema,
  backupManifestV6Schema,
  type BackupManifestPhotoV2,
  type BackupManifestV2,
} from '../../src/main/backup/backup-manifest.js';

// Era fixtures for the restore engine's "every supported schema restores
// forever" test (#1009). Kept beside restore-engine.test.ts, which is at its
// line budget; the shapes are frozen picks so photos built by today's helpers
// cannot leak later fields into a legacy generation.

/** The photo shape schema 2 shipped with (#289): no mediaInfo (#548), no
 * isOriginal (#482), no metadata block. Frozen as an explicit pick so photos
 * built by today's helpers cannot leak later fields into the era fixtures. */
export function legacyEraPhoto(photo: BackupManifestPhotoV2): BackupManifestPhotoV2 {
  return {
    id: photo.id,
    fileName: photo.fileName,
    fileKind: photo.fileKind,
    width: photo.width,
    height: photo.height,
    bytes: photo.bytes,
    contentHash: photo.contentHash,
    blobPath: photo.blobPath,
    camera: photo.camera,
    lens: photo.lens,
    iso: photo.iso,
    aperture: photo.aperture,
    shutter: photo.shutter,
    focalLength: photo.focalLength,
    takenAt: photo.takenAt,
    gpsLat: photo.gpsLat,
    gpsLon: photo.gpsLon,
    place: photo.place,
    importedAt: photo.importedAt,
    importSource: photo.importSource,
    favorite: photo.favorite,
    keyId: photo.keyId,
    deletedAt: photo.deletedAt,
  };
}

/** A manifest exactly as each schema era would have written it: the era's
 * sections over a schema-2 base, validated by the era's schema. */
export function makeEraManifest(schema: 2 | 3 | 4 | 5 | 6, v2: BackupManifestV2): unknown {
  if (schema === 2) return v2;
  const v3 = { ...v2, schema: 3, protectedAlbums: [], protectedPhotos: [] };
  if (schema === 3) return backupManifestV3Schema.parse(v3);
  const v4 = { ...v3, schema: 4, activity: [] };
  if (schema === 4) return backupManifestV4Schema.parse(v4);
  const v5 = { ...v4, schema: 5, boards: [] };
  if (schema === 5) return backupManifestV5Schema.parse(v5);
  return backupManifestV6Schema.parse({ ...v5, schema: 6, sidecars: [] });
}

/** Current companion custody over a legacy fixture, with explicit defaults
 * for sections introduced between the two schema eras. */
export function sharedOwnerManifest(
  input: {
    libraryId: string;
    generatedAt: string;
    snapshot: BackupManifestSnapshotV7;
  },
  ownerId: string,
  keys: KeyStore,
): BackupManifestV16 {
  return buildBackupManifestV16({
    ...input,
    snapshot: {
      ...input.snapshot,
      sidecars: input.snapshot.sidecars.map((sidecar) => ({ ...sidecar, ownerId })),
      hiddenAlbumIds: [],
      folders: [],
      albumTree: input.snapshot.albums.map((album) => ({ albumId: album.id, parentId: null, inheritsVisibility: false, tags: [] })),
      smartAlbums: [],
      editRevisions: [],
      provenance: [],
      variantFamilies: [],
      keyring: keys.listKeys().map((key) => ({
        keyId: key.id,
        keyRef: key.keyRef ?? '',
        version: key.version ?? 1,
        kind: key.kind ?? 'library',
        origin: key.origin ?? 'local',
        fingerprint: null,
        label: null,
      })),
    },
  });
}
