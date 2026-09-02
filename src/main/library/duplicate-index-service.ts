import type { FingerprintCandidate, FingerprintIndexStatus, FingerprintRepository } from '../db/fingerprint-repository.js';
import { DUPLICATE_DISTANCE_THRESHOLD, findDuplicateGroups, type DuplicateGroup } from '../../shared/library/duplicate-groups.js';
import { FINGERPRINT_VERSION, type Fingerprint } from '../../shared/library/perceptual-hash.js';
import type { PhotoRecord } from '../../shared/library/types.js';
import { FingerprintDecodeError } from './perceptual-fingerprint.js';

// Perceptual duplicate index (#650). One single-flight background pass
// fingerprints every ordinary photo without a fresh row, one at a time, from
// its own mid derivative; the review is derived on demand from the fresh
// rows and cached until the index, the classification (#482) or the library
// changes. Matches are suggestions: nothing here deletes, merges or moves
// custody, and the pair-eligibility policy is applied at grouping time so a
// re-classified pair can never be shown stale.

export interface DuplicateReview {
  readonly version: string;
  readonly threshold: number;
  readonly status: FingerprintIndexStatus;
  readonly groups: readonly DuplicateGroup[];
}

export interface DuplicateReviewWithPhotos extends Omit<DuplicateReview, 'groups'> {
  readonly groups: readonly { readonly id: string; readonly photos: readonly PhotoRecord[]; readonly pairs: DuplicateGroup['pairs'] }[];
}

export type FingerprintStore = Pick<
  FingerprintRepository,
  'pending' | 'status' | 'entries' | 'put' | 'defer' | 'invalidate' | 'invalidateAll' | 'deleteOtherVersions'
>;

export interface DuplicateIndexServiceOptions {
  readonly repository: FingerprintStore;
  /** The photo's mid derivative, or null when it is not in custody. */
  readonly load: (candidate: FingerprintCandidate, signal: AbortSignal) => Promise<Buffer | null>;
  /** The rotation set; throws FingerprintDecodeError for undecodable bytes. */
  readonly fingerprint: (bytes: Buffer, signal: AbortSignal) => Promise<readonly Fingerprint[]>;
  /** Group members resolved to records, in group order; missing ids are dropped. */
  readonly records: (photoIds: readonly string[]) => readonly PhotoRecord[];
  /** Index progress worth telling the renderer about. */
  readonly changed?: ((status: FingerprintIndexStatus) => void) | undefined;
  readonly threshold?: number | undefined;
  /** Rows written between progress notifications. */
  readonly notifyEvery?: number | undefined;
  readonly yieldTurn?: (() => Promise<void>) | undefined;
}

const yieldTurn = async (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class DuplicateIndexService {
  private running: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private restartRequested = false;
  private closed = false;
  private epoch = 0;
  private cache: { readonly epoch: number; readonly review: DuplicateReview } | null = null;

  constructor(private readonly options: DuplicateIndexServiceOptions) {}

  /** Starts (or queues a restart of) the background pass. */
  schedule(): void {
    if (this.closed) return;
    if (this.running !== undefined) {
      this.restartRequested = true;
      return;
    }
    const work = this.run();
    this.running = work;
    void work.finally(() => {
      if (this.running !== work) return;
      this.running = undefined;
      if (this.restartRequested) {
        this.restartRequested = false;
        this.schedule();
      }
    });
  }

  /** Derivatives regenerated in place, rows created or removed: re-index those photos. */
  notifyEligibilityChanged(photoIds: readonly string[]): void {
    if (this.closed) return;
    if (photoIds.length > 0) this.options.repository.invalidate(photoIds);
    this.bump();
    this.schedule();
  }

  /** A row appeared, vanished or moved (import, trash, restore): the review is stale. */
  notifyLibraryChanged(): void {
    this.bump();
    this.schedule();
  }

  /** #482 invalidation seam: the policy is applied at grouping time, so the
   * cached answer is dropped and unrelated groups are left alone. */
  notifyClassificationChanged(photoIds: readonly string[]): void {
    if (photoIds.length === 0) return;
    this.bump();
  }

  /**
   * Drops every fingerprint — hashed and deferred alike, so a preview that
   * has since become readable is retried — and starts over: the user's
   * explicit rescan.
   */
  rescan(): FingerprintIndexStatus {
    this.options.repository.invalidateAll();
    this.bump();
    this.schedule();
    return this.status();
  }

  status(): FingerprintIndexStatus {
    return this.options.repository.status(FINGERPRINT_VERSION);
  }

  review(): DuplicateReview {
    if (this.cache !== null && this.cache.epoch === this.epoch) return this.cache.review;
    const status = this.status();
    const review: DuplicateReview = {
      version: FINGERPRINT_VERSION,
      threshold: this.options.threshold ?? DUPLICATE_DISTANCE_THRESHOLD,
      status,
      groups: findDuplicateGroups(this.options.repository.entries(FINGERPRINT_VERSION), this.options.threshold),
    };
    this.cache = { epoch: this.epoch, review };
    if (status.pending > 0) this.schedule();
    return review;
  }

  reviewWithPhotos(): DuplicateReviewWithPhotos {
    const review = this.review();
    return {
      ...review,
      groups: review.groups.map((group) => {
        const byId = new Map(this.options.records(group.photoIds).map((photo) => [photo.id, photo]));
        return {
          id: group.id,
          photos: group.photoIds.flatMap((photoId) => {
            const photo = byId.get(photoId);
            return photo === undefined ? [] : [photo];
          }),
          pairs: group.pairs,
        };
      }),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    await this.running?.catch(() => undefined);
  }

  private bump(): void {
    this.epoch += 1;
    this.cache = null;
  }

  private async run(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    let written = 0;
    try {
      this.options.repository.deleteOtherVersions(FINGERPRINT_VERSION);
      while (!controller.signal.aborted) {
        const candidate = this.options.repository.pending(FINGERPRINT_VERSION, 1)[0];
        if (candidate === undefined) break;
        const stored = await this.index(candidate, controller.signal);
        if (controller.signal.aborted) break;
        if (stored) {
          written += 1;
          this.bump();
          if (written % (this.options.notifyEvery ?? 25) === 0) this.options.changed?.(this.status());
        }
        await (this.options.yieldTurn ?? yieldTurn)();
      }
    } finally {
      if (this.controller === controller) this.controller = undefined;
      if (!controller.signal.aborted && !this.closed) {
        this.bump();
        this.options.changed?.(this.status());
      }
    }
  }

  /** True when a fresh row (hash or deferral) was written for the candidate. */
  private async index(candidate: FingerprintCandidate, signal: AbortSignal): Promise<boolean> {
    let bytes: Buffer | null = null;
    try {
      bytes = await this.options.load(candidate, signal);
      if (signal.aborted) return false;
      if (bytes === null) return this.options.repository.defer(candidate, FINGERPRINT_VERSION, 'derivative-unavailable');
      const rotations = await this.options.fingerprint(bytes, signal);
      if (signal.aborted) return false;
      return this.options.repository.put(candidate, FINGERPRINT_VERSION, rotations);
    } catch (error) {
      if (signal.aborted) return false;
      if (error instanceof FingerprintDecodeError) return this.options.repository.defer(candidate, FINGERPRINT_VERSION, 'undecodable');
      // Anything else (a store fault, a worker crash) is deferred as
      // unavailable so the pass keeps moving; `invalidate()` retries it.
      console.error(`[overlook] fingerprint failed for ${candidate.photoId}`, error);
      return this.options.repository.defer(candidate, FINGERPRINT_VERSION, 'derivative-unavailable');
    } finally {
      bytes?.fill(0);
    }
  }
}
