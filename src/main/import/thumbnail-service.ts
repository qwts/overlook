import { Readable } from 'node:stream';

import type { BlobStore } from '../blobs/blob-store.js';
import type { EnvelopeKey } from '../crypto/envelope.js';
import type { ThumbnailDerivatives, ThumbnailPool } from './thumbnail-pool.js';
import type { FileKind } from '../../shared/library/types.js';
import type { EditTransform } from '../../shared/library/edit-revision.js';
import type { PreviewFailureReason } from '../../shared/library/preview.js';

// Thumbnail generation service (#86): pool output → encrypted blob store.
// Derivatives stream through the same envelope path as originals (encrypt-
// then-move, no plaintext temp files); a photo whose bytes can't decode is
// recorded as a placeholder (generated: false), never a failed import.

export interface ThumbnailOutcome {
  /** False = placeholder (undecodable/unsupported bytes, E5.3 contract). */
  readonly generated: boolean;
  readonly width: number | null;
  readonly height: number | null;
  readonly failure?: PreviewFailureReason | undefined;
}

export interface ThumbnailRequest {
  readonly photoId: string;
  /** Original file bytes (the pool resolves RAW previews itself). */
  readonly bytes: Buffer;
  /** Content hash of the ORIGINAL — derivatives are addressed under it. */
  readonly contentHash: string;
  readonly key: EnvelopeKey;
  readonly fileKind?: FileKind | undefined;
  /** Persisted edits baked into the derivatives (#493); absent = as imported. */
  readonly transform?: EditTransform | undefined;
  readonly signal?: AbortSignal | undefined;
}

export class ThumbnailService {
  constructor(
    private readonly pool: ThumbnailPool,
    private readonly blobStore: BlobStore,
  ) {}

  /**
   * Generates and stores both ADR-0006 derivatives for one photo. Returns
   * the outcome (feeds the import dialog's per-file bar via #87's progress
   * events); throws only on infrastructure failures (store IO, worker
   * crash), which the import engine surfaces as retryable.
   */
  async generateFor(request: ThumbnailRequest): Promise<ThumbnailOutcome> {
    return this.generateAndStore(request, false);
  }

  /** Repair path: new encrypted derivatives atomically replace missing or
   * corrupt legacy envelopes only after decode succeeds. */
  async regenerateFor(request: ThumbnailRequest): Promise<ThumbnailOutcome> {
    return this.generateAndStore(request, true);
  }

  private async generateAndStore(request: ThumbnailRequest, replace: boolean): Promise<ThumbnailOutcome> {
    const derivatives = await this.pool.generate(request.bytes, request.signal, request.fileKind, request.transform);
    if (derivatives === null) {
      return { generated: false, width: null, height: null };
    }
    if ('failure' in derivatives) {
      return { generated: false, width: null, height: null, failure: derivatives.failure };
    }
    try {
      await this.store(request, derivatives, replace);
      return { generated: true, width: derivatives.width, height: derivatives.height };
    } finally {
      derivatives.thumb.fill(0);
      derivatives.mid.fill(0);
    }
  }

  private async store(request: ThumbnailRequest, derivatives: ThumbnailDerivatives, replace: boolean): Promise<void> {
    const put = async (bytes: Buffer, size: 'thumb' | 'mid'): Promise<void> => {
      if (replace) {
        await this.blobStore.replaceThumb(Readable.from([bytes]), request.key, request.photoId, request.contentHash, size);
      } else {
        await this.blobStore.putThumb(Readable.from([bytes]), request.key, request.photoId, request.contentHash, size);
      }
    };
    await put(derivatives.thumb, 'thumb');
    await put(derivatives.mid, 'mid');
  }
}
