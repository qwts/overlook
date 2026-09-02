import { buffer } from 'node:stream/consumers';

import { BlobStoreError, type BlobStore } from '../blobs/blob-store.js';
import type { EnvelopeKey, KeyResolver } from '../crypto/envelope.js';
import type { PhotosRepository } from '../db/photos-repository.js';
import { extractMetadata } from './exif.js';
import { RawRepairService } from './raw-repair-service.js';
import type { ThumbnailService } from './thumbnail-service.js';
import { assetOwnerOf } from '../../shared/library/asset-owner.js';

export interface RawRepairRuntimeOptions {
  readonly repo: PhotosRepository;
  readonly blobs: BlobStore;
  readonly blobsReady: Promise<void>;
  readonly thumbnails: ThumbnailService;
  readonly currentKey: () => EnvelopeKey;
  readonly resolveKey: KeyResolver;
  readonly changed: (photoIds: readonly string[]) => void;
}

export function createRawRepairRuntime(options: RawRepairRuntimeOptions): RawRepairService {
  return new RawRepairService({
    candidates: () => options.repo.previewRepairCandidates(),
    validThumbs: async (photo) => options.blobs.verifyThumbs(photo.derivativeKey, options.resolveKey, photo.id),
    loadOriginal: async (photo) => {
      await options.blobsReady;
      try {
        return await buffer(options.blobs.getStream(photo.contentHash, options.resolveKey, assetOwnerOf(photo)));
      } catch (error) {
        if (error instanceof BlobStoreError) return null;
        throw error;
      }
    },
    extractMetadata: async (bytes, fileKind) => extractMetadata(bytes, fileKind),
    regenerate: async (photo, bytes, signal) =>
      options.thumbnails.regenerateFor({
        photoId: photo.id,
        bytes,
        contentHash: photo.contentHash,
        key: options.currentKey(),
        fileKind: photo.fileKind,
        signal,
      }),
    repairMetadata: (photoId, metadata) => options.repo.repairPreviewMetadata(photoId, metadata),
    repairGeneratedDimensions: (photoId, width, height) => options.repo.repairGeneratedDimensions(photoId, width, height),
    setDimensionStatus: (photoId, status) => options.repo.setDimensionStatus(photoId, status),
    setPreviewFailure: (photoId, failure) => options.repo.setPreviewFailure(photoId, failure),
    changed: options.changed,
  });
}
