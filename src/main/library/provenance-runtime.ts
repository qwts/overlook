import type { Readable } from 'node:stream';

import { BlobStoreError } from '../blobs/blob-store.js';
import { PhotosRepository } from '../db/photos-repository.js';
import { ProvenanceRepository } from '../db/provenance-repository.js';
import { SidecarRepository } from '../db/sidecar-repository.js';
import { extractProvenanceSources, PROVENANCE_SCAN_LIMIT } from '../import/provenance-extractor.js';
import type { LibraryParts } from './library-parts.js';
import { ProvenanceService } from './provenance-service.js';
import { assetOwnerOf } from '../../shared/library/asset-owner.js';

// Wires the provenance service (#495) to the library parts the way the edit
// service is wired: originals and XMP sidecars stream out of the encrypted
// blob store, extraction is the pure byte inspector, and the manifest side
// effect arrives as a callback.
export interface ProvenanceRuntimeContext {
  readonly parts: LibraryParts;
  readonly scheduleAutoBackup: () => void;
}

/**
 * Reads at most `limit` leading bytes of a stream, then stops it. The
 * extractor only ever inspects that window, so the rest of a large original
 * is neither decrypted nor held in memory. Stopping destroys the stream (and,
 * through the blob store's pipeline, the file behind it).
 */
export async function readPrefix(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    chunks.push(bytes);
    total += bytes.length;
    if (total >= limit) break;
  }
  const prefix = Buffer.concat(chunks, Math.min(total, limit));
  for (const chunk of chunks) chunk.fill(0);
  return prefix;
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
        return await readPrefix(
          parts.blobStore.getStream(photo.contentHash, parts.keyStore.resolver(), assetOwnerOf(photo)),
          PROVENANCE_SCAN_LIMIT,
        );
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
          loaded.push(
            await readPrefix(
              parts.blobStore.getSidecarStream(photo.id, sidecar.contentHash, parts.keyStore.resolver()),
              PROVENANCE_SCAN_LIMIT,
            ),
          );
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
