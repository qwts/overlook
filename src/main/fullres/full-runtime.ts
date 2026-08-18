import { buffer } from 'node:stream/consumers';

import { BlobStoreError, type BlobStore } from '../blobs/blob-store.js';
import type { KeyResolver } from '../crypto/envelope.js';
import type { PhotosRepository } from '../db/photos-repository.js';
import type { EphemeralOriginalService } from '../backup/ephemeral-originals.js';
import { FullService } from './full-service.js';
import { videoMimeFor } from '../../shared/library/media-info.js';

export interface FullRuntimeOptions {
  readonly repo: PhotosRepository;
  readonly blobs: BlobStore;
  readonly resolveKey: KeyResolver;
  readonly ephemeral: () => EphemeralOriginalService;
  readonly cacheMb: string | undefined;
}

export function createFullRuntime(options: FullRuntimeOptions): FullService {
  const budgetMb = Number(options.cacheMb ?? '');
  return new FullService({
    admit: (photoId) => options.repo.get(photoId) !== undefined,
    loadOriginal: async (photoId, purpose) => {
      const photo = options.repo.get(photoId);
      if (photo === undefined) return null;
      if (photo.syncState === 'offloaded' || photo.syncState === 'error') {
        try {
          const opened = await options.ephemeral().open(photoId, purpose);
          return { bytes: await buffer(opened.stream), contentHash: photo.contentHash, fileKind: photo.fileKind };
        } catch {
          return null;
        }
      }
      try {
        const stream = options.blobs.getStream(photo.contentHash, options.resolveKey, photoId);
        return { bytes: await buffer(stream), contentHash: photo.contentHash, fileKind: photo.fileKind };
      } catch (error) {
        if (error instanceof BlobStoreError) return null;
        throw error;
      }
    },
    // Video streams from the decrypting blob read — never whole-file to the LRU
    // (ADR-0026 §5). MIME follows the PROBED container (#549), never the
    // extension; unprobed rows fall back to the remux transport type.
    openVideoStream: async (photoId) => {
      const photo = options.repo.get(photoId);
      if (photo === undefined || photo.fileKind !== 'video') return null;
      const mime = videoMimeFor(photo.mediaInfo?.container);
      if (photo.syncState === 'offloaded' || photo.syncState === 'error') {
        try {
          const opened = await options.ephemeral().open(photoId, 'view');
          return { stream: opened.stream, totalBytes: photo.bytes, mime };
        } catch {
          return null;
        }
      }
      try {
        return { stream: options.blobs.getStream(photo.contentHash, options.resolveKey, photoId), totalBytes: photo.bytes, mime };
      } catch (error) {
        if (error instanceof BlobStoreError) return null;
        throw error;
      }
    },
    maxCacheBytes: Number.isFinite(budgetMb) && budgetMb > 0 ? budgetMb * 1024 * 1024 : undefined,
  });
}
