import type { HistogramPayload } from '../../shared/ipc/histogram-channels.js';
import { histogramDigest, type HistogramData } from '../../shared/library/histogram.js';
import type { PhotoRecord } from '../../shared/library/types.js';
import { HistogramDecodeError } from './histogram-runner.js';

// Inspector histogram (#498): bins over the photo's own mid derivative, which
// already carries the persisted edit stack (rotate, flip, crop) and survives
// offload, so the answer follows the focused photo, the active variant (its
// own derivative key) and the head revision. Answers are cached per photo
// and keyed on the head revision and derivative key; a repair or re-bake
// that changes neither is invalidated explicitly by the caller. In-flight
// work is keyed the same way plus a per-photo generation that invalidation
// bumps, so a job started before the derivative or the head changed is
// neither reused nor cached once it lands: only the newest job for a photo
// may remember. Unavailable answers are never cached — a repair may fix
// them — and never fabricated.

export interface HistogramServiceDeps {
  readonly repo: { get(photoId: string): PhotoRecord | undefined };
  /** The head revision the derivatives were baked for (null = empty root). */
  readonly headRevisionId: (photoId: string) => string | null;
  /** The photo's own mid derivative, decrypted; null when custody has none. */
  readonly loadMid: (photo: PhotoRecord) => Promise<Buffer | null>;
  readonly compute: (bytes: Buffer) => Promise<HistogramData>;
  /** Cached answers kept (least recently used first out). Default 16. */
  readonly cacheSize?: number;
}

interface CacheEntry {
  readonly revisionId: string | null;
  readonly derivativeKey: string;
  readonly payload: HistogramPayload;
}

interface InFlightEntry {
  readonly generation: number;
  readonly revisionId: string | null;
  readonly derivativeKey: string;
  readonly task: Promise<HistogramPayload>;
}

const DEFAULT_CACHE_SIZE = 16;

export class HistogramService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlightEntry>();
  /** Bumped by invalidate(): a job from an older generation never caches. */
  private readonly generations = new Map<string, number>();

  constructor(private readonly deps: HistogramServiceDeps) {}

  async get(photoId: string): Promise<HistogramPayload> {
    const photo = this.deps.repo.get(photoId);
    if (photo === undefined) return { state: 'unavailable', photoId, reason: 'missing' };
    if (photo.previewFailure !== null) return { state: 'unavailable', photoId, reason: 'preview-failure' };
    const revisionId = this.deps.headRevisionId(photoId);
    const cached = this.cache.get(photoId);
    if (cached !== undefined && cached.revisionId === revisionId && cached.derivativeKey === photo.derivativeKey) {
      this.cache.delete(photoId);
      this.cache.set(photoId, cached);
      return cached.payload;
    }
    const generation = this.generations.get(photoId) ?? 0;
    const pending = this.inFlight.get(photoId);
    if (
      pending !== undefined &&
      pending.generation === generation &&
      pending.revisionId === revisionId &&
      pending.derivativeKey === photo.derivativeKey
    ) {
      return pending.task;
    }
    const entry: InFlightEntry = {
      generation,
      revisionId,
      derivativeKey: photo.derivativeKey,
      task: this.build(
        photo,
        revisionId,
        () => this.inFlight.get(photoId) === entry && (this.generations.get(photoId) ?? 0) === generation,
      ).finally(() => {
        if (this.inFlight.get(photoId) === entry) this.inFlight.delete(photoId);
      }),
    };
    this.inFlight.set(photoId, entry);
    return entry.task;
  }

  /** Derivatives changed without a head change (repair, poster, restore). */
  invalidate(photoIds: readonly string[]): void {
    for (const photoId of photoIds) {
      this.cache.delete(photoId);
      this.generations.set(photoId, (this.generations.get(photoId) ?? 0) + 1);
    }
  }

  private async build(photo: PhotoRecord, revisionId: string | null, current: () => boolean): Promise<HistogramPayload> {
    const bytes = await this.deps.loadMid(photo);
    if (bytes === null) return { state: 'unavailable', photoId: photo.id, reason: 'missing' };
    let data: HistogramData;
    try {
      data = await this.deps.compute(bytes);
    } catch (error) {
      if (error instanceof HistogramDecodeError) return { state: 'unavailable', photoId: photo.id, reason: 'corrupt' };
      throw error;
    } finally {
      bytes.fill(0);
    }
    const payload: HistogramPayload = {
      state: 'ready',
      photoId: photo.id,
      revisionId,
      source: 'mid',
      width: data.width,
      height: data.height,
      pixels: data.pixels,
      channels: data.channels,
      clipping: data.clipping,
      digest: histogramDigest(data.channels),
    };
    // Superseded under this job (a repair, a re-bake, a newer head): the
    // answer is handed to the caller that asked for it, never cached.
    if (current()) this.remember(photo.id, { revisionId, derivativeKey: photo.derivativeKey, payload });
    return payload;
  }

  private remember(photoId: string, entry: CacheEntry): void {
    this.cache.delete(photoId);
    this.cache.set(photoId, entry);
    const limit = this.deps.cacheSize ?? DEFAULT_CACHE_SIZE;
    while (this.cache.size > limit) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
