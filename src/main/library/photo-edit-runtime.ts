import { buffer } from 'node:stream/consumers';

import { BlobStoreError } from '../blobs/blob-store.js';
import { PhotosRepository } from '../db/photos-repository.js';
import type { ImportRuntime } from '../import/import-runtime.js';
import { ulid } from '../import/ulid.js';
import type { LibraryParts } from './library-parts.js';
import { PhotoEditService } from './photo-edit-service.js';

// Wires the edit service (#493) to the library parts the way the maintenance
// passes are wired: originals stream out of the encrypted blob store, the
// import runtime's thumbnail service re-bakes derivatives, and the renderer
// side effects arrive as callbacks so this module stays free of window and
// emitter details.
export interface PhotoEditRuntimeContext {
  readonly parts: LibraryParts;
  readonly runtime: ImportRuntime;
  readonly appVersion: string;
  readonly invalidateThumb: (photoId: string) => void;
  /** Derivative-only refresh: the tiles reload, the page never refetches. */
  readonly emitThumbsChanged: (photoIds: readonly string[]) => void;
  readonly emitPending: (count: number) => void;
  readonly scheduleAutoBackup: () => void;
}

export function createPhotoEditRuntime(ctx: PhotoEditRuntimeContext): PhotoEditService {
  const repo = new PhotosRepository(ctx.parts.db);
  return new PhotoEditService({
    db: ctx.parts.db,
    repo,
    loadOriginal: async (photo) => {
      await ctx.parts.blobStoreReady;
      try {
        return await buffer(ctx.parts.blobStore.getStream(photo.contentHash, ctx.parts.keyStore.resolver(), photo.id));
      } catch (error) {
        if (error instanceof BlobStoreError) return null;
        throw error;
      }
    },
    regenerate: async (photo, bytes, transform) =>
      ctx.runtime.thumbnails.regenerateFor({
        photoId: photo.id,
        bytes,
        contentHash: photo.contentHash,
        key: ctx.parts.keyStore.currentKey(),
        fileKind: photo.fileKind,
        transform,
      }),
    appVersion: ctx.appVersion,
    newId: () => ulid(),
    now: () => new Date().toISOString(),
    changed: (photoId, derivatives) => {
      if (derivatives === 'regenerated') {
        ctx.invalidateThumb(photoId);
        ctx.emitThumbsChanged([photoId]);
      }
      ctx.emitPending(repo.pendingCount());
      ctx.scheduleAutoBackup();
    },
  });
}
