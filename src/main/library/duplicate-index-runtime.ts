import { buffer } from 'node:stream/consumers';

import { BlobStoreError } from '../blobs/blob-store.js';
import { FingerprintRepository, type FingerprintIndexStatus } from '../db/fingerprint-repository.js';
import { PhotosRepository } from '../db/photos-repository.js';
import { DuplicateIndexService } from './duplicate-index-service.js';
import type { LibraryParts } from './library-parts.js';
import { fingerprintImage } from './perceptual-fingerprint.js';

// Wires the perceptual duplicate index (#650) to the library parts: the mid
// derivative streams out of the encrypted blob store under the row's own key
// and id (a variant's own derivative, #496), sharp fingerprints it in main,
// and the rows live in SQLCipher beside the photo. No Electron imports so the
// factory stays unit-testable.

export interface DuplicateIndexRuntimeOptions {
  readonly parts: LibraryParts;
  readonly changed?: ((status: FingerprintIndexStatus) => void) | undefined;
}

export interface DuplicateIndexRuntime {
  readonly service: DuplicateIndexService;
  readonly close: () => Promise<void>;
}

export function createDuplicateIndexRuntime(options: DuplicateIndexRuntimeOptions): DuplicateIndexRuntime {
  const photos = new PhotosRepository(options.parts.db);
  const service = new DuplicateIndexService({
    repository: new FingerprintRepository(options.parts.db),
    load: async (candidate) => {
      await options.parts.blobStoreReady;
      try {
        return await buffer(
          options.parts.blobStore.getThumbStream(candidate.derivativeKey, 'mid', options.parts.keyStore.resolver(), candidate.photoId),
        );
      } catch (error) {
        if (error instanceof BlobStoreError) return null;
        throw error;
      }
    },
    fingerprint: (bytes, signal) => fingerprintImage(bytes, signal),
    records: (photoIds) => photos.records(photoIds),
    changed: options.changed,
  });
  return { service, close: () => service.close() };
}
