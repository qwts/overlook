import { OriginalAvailabilityRepository } from '../db/original-availability.js';
import { PhotosRepository } from '../db/photos-repository.js';
import type { LibraryParts } from './library-parts.js';
import { OriginalRecoveryService } from './original-recovery-service.js';

export function createOriginalRecoveryRuntime(
  parts: LibraryParts,
  changed: (photoIds: readonly string[]) => void,
): OriginalRecoveryService {
  const repo = new PhotosRepository(parts.db);
  const availability = new OriginalAvailabilityRepository(parts.db);
  return new OriginalRecoveryService({
    getPhoto: (id) => repo.get(id),
    blobs: parts.blobStore,
    ready: parts.blobStoreReady,
    writeKey: () => {
      const key = parts.keyStore.currentKey();
      return { ...key, key: Buffer.from(key.key) };
    },
    resolveKey: parts.keyStore.resolver(),
    restored: (hash, keyId) => changed(availability.recoveredLocal(hash, keyId)),
  });
}
