import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { BlobStore } from '../blobs/blob-store.js';
import type { EnvelopeKey, KeyResolver } from '../crypto/envelope.js';
import { posterCaptureCandidates } from '../db/poster-candidates.js';
import type { PhotoRecord } from '../../shared/library/types.js';
import { PosterCaptureService } from './poster-capture-service.js';
import type { ThumbnailService } from './thumbnail-service.js';

export interface PosterCaptureRuntimeOptions {
  readonly db: BetterSqlite3.Database;
  readonly blobs: BlobStore;
  readonly blobsReady: Promise<void>;
  readonly thumbnails: ThumbnailService;
  readonly currentKey: () => EnvelopeKey;
  readonly resolveKey: KeyResolver;
  readonly changed: (photoIds: readonly string[]) => void;
  /** The offscreen decoder, injected by the wiring layer. Kept out of this
   * module (no static Electron import) so the runtime is unit-testable and
   * coverage-enforced; only the composition root pulls in the real capturer. */
  readonly captureFrame: (photo: PhotoRecord, signal: AbortSignal) => Promise<Buffer | null>;
}

export function createPosterCaptureRuntime(options: PosterCaptureRuntimeOptions): PosterCaptureService {
  return new PosterCaptureService({
    candidates: () => posterCaptureCandidates(options.db),
    hasPoster: async (photo) => options.blobs.verifyThumbs(photo.derivativeKey, options.resolveKey, photo.id),
    captureFrame: async (photo, signal) => {
      await options.blobsReady;
      return options.captureFrame(photo, signal);
    },
    // The captured frame is a PNG — feed it to the sharp chain as an image; the
    // stored poster lands at the same derivative path the grid already loads.
    storePoster: async (photo, frame, signal) =>
      options.thumbnails.regenerateFor({
        photoId: photo.id,
        bytes: frame,
        contentHash: photo.contentHash,
        key: options.currentKey(),
        fileKind: 'png',
        signal,
      }),
    changed: options.changed,
  });
}
