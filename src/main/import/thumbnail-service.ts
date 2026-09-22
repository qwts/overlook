import { Readable } from 'node:stream';

import type { BlobStore } from '../blobs/blob-store.js';
import type { EnvelopeKey } from '../crypto/envelope.js';
import type { ThumbnailDerivatives, ThumbnailPoolResult } from './thumbnail-pool.js';
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
  /** Cancelled or superseded work must not publish availability/metadata changes. */
  readonly discarded?: boolean | undefined;
  readonly width: number | null;
  readonly height: number | null;
  readonly failure?: PreviewFailureReason | undefined;
}

export interface ThumbnailRequest {
  readonly photoId: string;
  /** Original file bytes (the pool resolves RAW previews itself). */
  readonly bytes: Buffer;
  /** Content hash of the ORIGINAL — derivatives are addressed under it
   * unless `derivativeKey` says otherwise. */
  readonly contentHash: string;
  /** The variant's derivative address (#496): a duplicate's thumbs must not
   * overwrite its siblings'. Absent = the content hash (a root variant). */
  readonly derivativeKey?: string | undefined;
  readonly key: EnvelopeKey;
  readonly fileKind?: FileKind | undefined;
  /** Persisted edits baked into the derivatives (#493); absent = as imported. */
  readonly transform?: EditTransform | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Superseded edits may decode, but must not replace a newer head. */
  readonly isCurrent?: (() => boolean) | undefined;
}

function canPublish(request: ThumbnailRequest): boolean {
  return request.signal?.aborted !== true && request.isCurrent?.() !== false;
}

interface ThumbnailGenerator {
  generate(bytes: Buffer, signal?: AbortSignal, fileKind?: FileKind, transform?: EditTransform): Promise<ThumbnailPoolResult>;
}

export class ThumbnailService {
  private readonly replacements = new Map<string, Promise<unknown>>();
  constructor(
    private readonly pool: ThumbnailGenerator,
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
    const previous = this.replacements.get(request.photoId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(() => this.generateAndStore(request, true));
    this.replacements.set(request.photoId, pending);
    try {
      return await pending;
    } finally {
      if (this.replacements.get(request.photoId) === pending) this.replacements.delete(request.photoId);
    }
  }

  private async generateAndStore(request: ThumbnailRequest, replace: boolean): Promise<ThumbnailOutcome> {
    if (!canPublish(request)) return { generated: false, width: null, height: null, discarded: true };
    const derivatives = await this.pool.generate(request.bytes, request.signal, request.fileKind, request.transform);
    try {
      if (!canPublish(request)) return { generated: false, width: null, height: null, discarded: true };
      if (derivatives === null) {
        return { generated: false, width: null, height: null };
      }
      if ('failure' in derivatives) {
        return { generated: false, width: null, height: null, failure: derivatives.failure };
      }
      await this.store(request, derivatives, replace);
      if (request.isCurrent?.() === false) return { generated: false, width: null, height: null, discarded: true };
      return { generated: true, width: derivatives.width, height: derivatives.height };
    } finally {
      if (derivatives !== null && !('failure' in derivatives)) {
        derivatives.thumb.fill(0);
        derivatives.mid.fill(0);
      }
    }
  }

  private async store(request: ThumbnailRequest, derivatives: ThumbnailDerivatives, replace: boolean): Promise<void> {
    const address = request.derivativeKey ?? request.contentHash;
    const put = async (bytes: Buffer, size: 'thumb' | 'mid'): Promise<void> => {
      if (replace) {
        await this.blobStore.replaceThumb(Readable.from([bytes]), request.key, request.photoId, address, size);
      } else {
        await this.blobStore.putThumb(Readable.from([bytes]), request.key, request.photoId, address, size);
      }
    };
    await put(derivatives.thumb, 'thumb');
    await put(derivatives.mid, 'mid');
  }
}
