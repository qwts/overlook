import type { ThumbnailOutcome } from './thumbnail-service.js';
import type { PhotoRecord } from '../../shared/library/types.js';

// Deterministic video poster capture (ADR-0026 §6). Runs as post-import
// background work — one capture at a time, off the import hot path — so a video
// grid tile gains its first-decodable-frame poster without ever blocking import
// or moving the grid. A frame that can't be captured within budget leaves the
// kind-placeholder tile in place: a placeholder is a success state, never a
// failed import (§6). Capture never touches the stored original — the frame
// feeds the existing sharp derivative chain and the poster is regenerable cache.

export interface CapturedPosterFrame {
  readonly bytes: Buffer;
  readonly sourceDimensions: { readonly width: number; readonly height: number } | null;
}

export interface PosterCaptureSummary {
  readonly scanned: number;
  readonly captured: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface PosterCaptureServiceOptions {
  /** Video/animated candidates that may still need a poster. */
  readonly candidates: (photoIds?: readonly string[]) => readonly PhotoRecord[];
  /** True when a valid poster derivative already exists (skip). */
  readonly hasPoster: (photo: PhotoRecord) => Promise<boolean>;
  /** Captures encoded image bytes and source dimensions, or null when no
   * frame decodes within the wall-clock/pixel budget (§9). Never throws for a
   * decode miss — that is a null, so the placeholder simply stays. */
  readonly captureFrame: (photo: PhotoRecord, signal: AbortSignal) => Promise<CapturedPosterFrame | null>;
  /** Feeds a captured frame to the sharp derivative chain and stores the poster. */
  readonly storePoster: (photo: PhotoRecord, frame: Buffer, signal: AbortSignal) => Promise<ThumbnailOutcome>;
  /** Notifies the renderer that these items gained a poster (grid refresh). */
  readonly repaired?: ((photo: PhotoRecord, frame: CapturedPosterFrame) => void) | undefined;
  readonly changed: (photoIds: readonly string[], membership: 'none' | 'library') => void;
  readonly yieldTurn?: (() => Promise<void>) | undefined;
}

const defaultYield = async (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** One cancellable, sequential capture pass. Sequential single-frame capture
 * keeps peak memory to one offscreen frame plus the thumbnail pool's outputs. */
export class PosterCaptureService {
  private readonly controller = new AbortController();
  private active: Promise<PosterCaptureSummary> | null = null;
  private queued = false;
  private readonly queuedPhotos = new Set<string>();

  constructor(private readonly options: PosterCaptureServiceOptions) {}

  close(): void {
    this.controller.abort();
  }

  /** Run a capture pass, coalescing concurrent callers. The startup maintenance
   * pass and every post-import trigger funnel through here; a call that arrives
   * while a pass is running queues exactly one follow-up pass (never a second
   * concurrent offscreen decode), so a video imported mid-pass still gets its
   * poster on the trailing pass. */
  capture(): Promise<PosterCaptureSummary> {
    this.queued = true;
    return this.runQueued();
  }

  /** Explicit retries share the background decoder and wait for their own pass. */
  async capturePhoto(photoId: string): Promise<void> {
    this.queuedPhotos.add(photoId);
    await this.runQueued();
  }

  private runQueued(): Promise<PosterCaptureSummary> {
    this.active ??= this.drain().finally(() => {
      this.active = null;
    });
    return this.active;
  }

  private async drain(): Promise<PosterCaptureSummary> {
    const total = { scanned: 0, captured: 0, failed: 0, skipped: 0 };
    while ((this.queued || this.queuedPhotos.size > 0) && !this.controller.signal.aborted) {
      let ids: readonly string[] | undefined;
      if (this.queued) {
        this.queued = false;
      } else {
        ids = [...this.queuedPhotos];
        this.queuedPhotos.clear();
      }
      const pass = await this.runPass(ids);
      total.scanned += pass.scanned;
      total.captured += pass.captured;
      total.failed += pass.failed;
      total.skipped += pass.skipped;
    }
    return total;
  }

  private async runPass(photoIds?: readonly string[]): Promise<PosterCaptureSummary> {
    let scanned = 0;
    let captured = 0;
    let failed = 0;
    let skipped = 0;
    const changed: string[] = [];
    const yieldTurn = this.options.yieldTurn ?? defaultYield;

    for (const photo of this.options.candidates(photoIds)) {
      if (this.controller.signal.aborted) break;
      if (photoIds !== undefined && !photoIds.includes(photo.id)) continue;
      scanned += 1;
      try {
        if (photo.locked || photo.deletedAt !== null || photo.syncState === 'offloaded' || photo.fileKind !== 'video') {
          skipped += 1;
          continue;
        }
        if (photoIds === undefined && (await this.options.hasPoster(photo))) {
          skipped += 1;
          continue;
        }
        const frame = await this.options.captureFrame(photo, this.controller.signal);
        if (this.controller.signal.aborted) break;
        if (frame === null) {
          // No decodable frame within budget — keep the placeholder tile.
          failed += 1;
          continue;
        }
        const outcome = await this.options.storePoster(photo, frame.bytes, this.controller.signal);
        if (this.controller.signal.aborted) break;
        if (outcome.generated) {
          if (photoIds !== undefined) this.options.repaired?.(photo, frame);
          captured += 1;
          changed.push(photo.id);
        } else {
          failed += 1;
        }
      } catch {
        // Background work must never surface: a capture fault leaves the
        // placeholder and the item is retried on the next pass.
        failed += 1;
      }
      await yieldTurn();
    }

    if (changed.length > 0 && !this.controller.signal.aborted) {
      this.options.changed(changed, photoIds === undefined ? 'none' : 'library');
    }
    return { scanned, captured, failed, skipped };
  }
}
