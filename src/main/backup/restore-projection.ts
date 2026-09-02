import type { RestoreMissingObject } from '../../shared/backup/restore-contract.js';
import type { RestorableBackupManifest } from './backup-manifest.js';

/** The user's explicit "verified only" choice makes a reduced, internally
 * consistent manifest the restore truth. Historical activity and board
 * layouts remain evidence; they are not remote-custody claims. */
export function projectVerifiedManifest(
  manifest: RestorableBackupManifest,
  missing: readonly RestoreMissingObject[],
): RestorableBackupManifest {
  const missingPaths = new Set(missing.map((object) => object.path));
  const lostPhotoIds = new Set(
    missing.filter((object) => object.kind === 'original' && object.photoId !== null).map((object) => object.photoId as string),
  );
  const photos = manifest.photos.filter((photo) => !lostPhotoIds.has(photo.id));
  const retainedPhotoIds = new Set(photos.map((photo) => photo.id));
  const albums = manifest.albums.map((album) => ({
    ...album,
    photoIds: album.photoIds.filter((photoId) => retainedPhotoIds.has(photoId)),
  }));
  const keyIds = [...new Set(photos.map((photo) => photo.keyId))].sort((left, right) => left - right);
  const ordinary = {
    keyIds,
    photos,
    albums,
    totals: {
      photos: photos.length,
      bytes: photos.reduce((total, photo) => total + photo.bytes, 0),
      albums: albums.length,
    },
  };
  if (manifest.schema === 2) return { ...manifest, ...ordinary };
  const protectedPhotos = manifest.protectedPhotos.filter((photo) =>
    photo.objects.every((object) => object.status === 'offloaded' || !missingPaths.has(object.path)),
  );
  if (manifest.schema === 3) return { ...manifest, ...ordinary, protectedPhotos };
  if (manifest.schema === 4) return { ...manifest, ...ordinary, protectedPhotos };
  if (manifest.schema === 5) return { ...manifest, ...ordinary, protectedPhotos };
  const sidecars = manifest.sidecars.filter((sidecar) => retainedPhotoIds.has(sidecar.photoId) && !missingPaths.has(sidecar.blobPath));
  if (!('variantFamilies' in manifest)) return { ...manifest, ...ordinary, protectedPhotos, sidecars };
  // A family whose representative was projected out (#496): the variants
  // share the lost original, so the family has nothing left to represent
  // and its row would only dangle a foreign key at restore.
  const variantFamilies = manifest.variantFamilies.filter((family) => retainedPhotoIds.has(family.representativeId));
  return { ...manifest, ...ordinary, protectedPhotos, sidecars, variantFamilies };
}
