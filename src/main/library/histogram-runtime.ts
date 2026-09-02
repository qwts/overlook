import { buffer } from 'node:stream/consumers';

import { BlobStoreError } from '../blobs/blob-store.js';
import { EditRevisionRepository } from '../db/edit-revision-repository.js';
import { PhotosRepository } from '../db/photos-repository.js';
import { HistogramRunner } from './histogram-runner.js';
import { HistogramService } from './histogram-service.js';
import type { LibraryParts } from './library-parts.js';

// Wires the histogram service (#498) to the library parts: the mid derivative
// streams out of the encrypted blob store under the row's own key and id,
// the head revision comes from the edit ledger, and the bins are computed on
// a dedicated worker thread so neither Electron's main thread nor the
// renderer decodes pixels.

export interface HistogramRuntimeOptions {
  readonly parts: LibraryParts;
  /** Defaults to the bundled worker beside this module. */
  readonly workerUrl?: URL | undefined;
}

export interface HistogramRuntime {
  readonly service: HistogramService;
  readonly close: () => Promise<void>;
}

export function createHistogramRuntime(options: HistogramRuntimeOptions): HistogramRuntime {
  const runner = new HistogramRunner({ workerUrl: options.workerUrl ?? new URL('./histogram-worker.js', import.meta.url) });
  const revisions = new EditRevisionRepository(options.parts.db);
  const service = new HistogramService({
    repo: new PhotosRepository(options.parts.db),
    headRevisionId: (photoId) => revisions.headRow(photoId)?.id ?? null,
    loadMid: async (photo) => {
      await options.parts.blobStoreReady;
      try {
        return await buffer(
          options.parts.blobStore.getThumbStream(photo.derivativeKey, 'mid', options.parts.keyStore.resolver(), photo.id),
        );
      } catch (error) {
        if (error instanceof BlobStoreError) return null;
        throw error;
      }
    },
    compute: (bytes) => runner.compute(bytes),
  });
  return { service, close: () => runner.close() };
}
