import { sidecarOwnerOf } from '../../shared/library/sidecar-files.js';
import type { PhotosRepository } from '../db/photos-repository.js';
import type { SidecarRepository } from '../db/sidecar-repository.js';
import type { PurgeDeps } from './purge-service.js';

export function createPurgeRepository(repo: PhotosRepository, sidecars?: SidecarRepository): PurgeDeps['repo'] {
  return {
    getDeleted: (id) => repo.getDeleted(id),
    getAny: (id) => repo.get(id),
    purgeRow: (id) => repo.purgeRow(id),
    purgeRowAuthorized: (id) => repo.purgeRowAuthorized(id),
    countAnyByContentHash: (hash) => repo.countAnyByContentHash(hash),
    expiredDeleted: (cutoff) => repo.expiredDeleted(cutoff),
    sidecarObjectsForPhoto: (id) =>
      (sidecars?.listForPhoto(id) ?? []).map((row) => ({ ownerId: sidecarOwnerOf(row), contentHash: row.contentHash })),
    hasSidecarOwner: (id) => sidecars?.hasOwner(id) ?? false,
    hasSidecarObject: (id, hash) => sidecars?.hasObject(id, hash) ?? false,
    sidecarHashesForPhoto: (id) => (sidecars === undefined ? [] : sidecars.listForPhoto(id).map((row) => row.contentHash)),
  };
}
