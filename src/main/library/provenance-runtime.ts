import { buffer } from 'node:stream/consumers';

import { BlobStoreError } from '../blobs/blob-store.js';
import { PhotosRepository } from '../db/photos-repository.js';
import { ProvenanceRepository } from '../db/provenance-repository.js';
import { SidecarRepository } from '../db/sidecar-repository.js';
import { extractProvenanceSources } from '../import/provenance-extractor.js';
import type { LibraryParts } from './library-parts.js';
import { ProvenanceService } from './provenance-service.js';

// Wires the provenance service (#495) to the library parts the way the edit
// service is wired: originals and XMP sidecars stream out of the encrypted
// blob store, extraction is the pure byte inspector, and the manifest side
// effect arrives as a callback.
export interface ProvenanceRuntimeContext {
  readonly parts: LibraryParts;
  readonly scheduleAutoBackup: () => void;
}

export function createProvenanceRuntime(ctx: ProvenanceRuntimeContext): ProvenanceService {
  const { parts } = ctx;
  const sidecars = new SidecarRepository(parts.db);
  return new ProvenanceService({
    repo: new PhotosRepository(parts.db),
    provenance: new ProvenanceRepository(parts.db),
    loadOriginal: async (photo) => {
      await parts.blobStoreReady;
      try {
        return await buffer(parts.blobStore.getStream(photo.contentHash, parts.keyStore.resolver(), photo.id));
      } catch (error) {
        if (error instanceof BlobStoreError) return null;
        throw error;
      }
    },
    loadSidecarXmp: async (photo) => {
      const loaded: Buffer[] = [];
      for (const sidecar of sidecars.listForPhoto(photo.id)) {
        if (sidecar.role !== 'xmp') continue;
        try {
          loaded.push(await buffer(parts.blobStore.getSidecarStream(photo.id, sidecar.contentHash, parts.keyStore.resolver())));
        } catch (error) {
          if (!(error instanceof BlobStoreError)) throw error;
        }
      }
      return loaded;
    },
    extract: extractProvenanceSources,
    now: () => new Date().toISOString(),
    changed: () => ctx.scheduleAutoBackup(),
  });
}
