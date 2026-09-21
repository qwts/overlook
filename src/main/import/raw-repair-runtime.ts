import { buffer } from 'node:stream/consumers';

import { BlobStoreError, type BlobStore } from '../blobs/blob-store.js';
import type { EnvelopeKey, KeyResolver } from '../crypto/envelope.js';
import type { PhotosRepository } from '../db/photos-repository.js';
import { extractMetadata } from './exif.js';
import { RawRepairService } from './raw-repair-service.js';
import type { ThumbnailService } from './thumbnail-service.js';
import type { EditRevisionRepository } from '../db/edit-revision-repository.js';
import { IDENTITY_TRANSFORM } from '../../shared/library/edit-revision.js';
import { assetOwnerOf } from '../../shared/library/asset-owner.js';

export interface RawRepairRuntimeOptions {
  readonly repo: PhotosRepository;
  readonly revisions: Pick<EditRevisionRepository, 'head'>;
  readonly blobs: BlobStore;
  readonly blobsReady: Promise<void>;
  readonly thumbnails: ThumbnailService;
  readonly currentKey: () => EnvelopeKey;
  readonly resolveKey: KeyResolver;
  readonly changed: (photoIds: readonly string[], membership: 'none' | 'library') => void;
}

export function createRawRepairRuntime(options: RawRepairRuntimeOptions): RawRepairService {
  return new RawRepairService({
    candidates: (hashes) => options.repo.previewRepairCandidates(hashes),
    isUnavailable: (photoId) => {
      const photo = options.repo.get(photoId);
      return photo !== undefined && (photo.previewFailure !== null || photo.dimensionStatus === 'unavailable');
    },
    validThumbs: async (photo) => options.blobs.verifyThumbs(photo.derivativeKey, options.resolveKey, photo.id),
    setPreviewMissing: (photoId, missing) => options.repo.setPreviewMissing(photoId, missing),
    loadOriginal: async (photo) => {
      await options.blobsReady;
      const head = options.revisions.head(photo.id).head;
      if (head !== null && head.unsupported !== null) return null;
      try {
        return await buffer(options.blobs.getStream(photo.contentHash, options.resolveKey, assetOwnerOf(photo)));
      } catch (error) {
        if (error instanceof BlobStoreError) return null;
        throw error;
      }
    },
    extractMetadata: async (bytes, fileKind) => extractMetadata(bytes, fileKind),
    regenerate: async (photo, bytes, signal) => {
      const head = options.revisions.head(photo.id).head;
      if (head !== null && head.unsupported !== null) throw new Error('unsupported edit head');
      return options.thumbnails.regenerateFor({
        photoId: photo.id,
        bytes,
        contentHash: photo.contentHash,
        // A duplicate's repaired derivatives land under its own key (#496);
        // omitting it would overwrite the root's tiles.
        derivativeKey: photo.derivativeKey,
        key: options.currentKey(),
        fileKind: photo.fileKind,
        transform: head?.transform ?? IDENTITY_TRANSFORM,
        signal,
      });
    },
    clearPreviewRepairDebt: (photoId) => options.repo.clearPreviewRepairDebt(photoId),
    repairMetadata: (photoId, metadata) => options.repo.repairPreviewMetadata(photoId, metadata),
    repairGeneratedDimensions: (photoId, width, height) => options.repo.repairGeneratedDimensions(photoId, width, height),
    setDimensionStatus: (photoId, status) => options.repo.setDimensionStatus(photoId, status),
    setPreviewFailure: (photoId, failure) => options.repo.setPreviewFailure(photoId, failure),
    changed: options.changed,
  });
}
