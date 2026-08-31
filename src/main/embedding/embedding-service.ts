import { setTimeout as delay } from 'node:timers/promises';

import {
  EmbeddingCandidateStaleError,
  type EmbeddingCandidate,
  type EmbeddingIndexStatus,
  type EmbeddingRepository,
} from '../db/embedding-repository.js';
import type { ModelAssetManager, ModelDownloadProgress } from './model-assets.js';
import { EMBEDDING_MODEL_MANIFEST } from './model-manifest.js';
import { EmbeddingPoolBusyError } from './embedding-pool.js';

export type EmbeddingPauseReason = 'user' | 'import' | 'backup' | 'battery';
export type EmbeddingPhase = 'disabled' | 'unavailable' | 'downloading' | 'indexing' | 'paused' | 'ready' | 'error';

export interface EmbeddingStatus extends EmbeddingIndexStatus {
  readonly phase: EmbeddingPhase;
  readonly pauseReason: EmbeddingPauseReason | null;
  readonly modelVersion: string;
  readonly downloadedBytes: number;
  readonly downloadBytes: number;
  readonly error: string | null;
}

export interface EmbeddingServiceOptions {
  readonly repository: Pick<
    EmbeddingRepository,
    'status' | 'deleteStale' | 'deleteOtherModels' | 'pending' | 'put' | 'defer' | 'clearDeferred'
  >;
  readonly assets: Pick<ModelAssetManager, 'installed' | 'ensureInstalled'>;
  readonly enabled: () => boolean;
  readonly setEnabled: (enabled: boolean) => void;
  readonly pauseReason: () => Exclude<EmbeddingPauseReason, 'user'> | null;
  readonly load: (candidate: EmbeddingCandidate, signal: AbortSignal) => Promise<Buffer | null>;
  readonly embed: (bytes: Buffer, signal: AbortSignal) => Promise<Int8Array | null>;
  readonly embedText?: ((text: string, signal: AbortSignal) => Promise<Int8Array>) | undefined;
  readonly emit: (status: EmbeddingStatus) => void;
  readonly available?: boolean;
  readonly unavailableReason?: string;
  readonly pausePollMs?: number;
  readonly downloadPublishIntervalMs?: number;
}

export type EmbeddingQueryFallback = 'disabled' | 'unavailable' | 'indexing' | 'busy' | 'error';
export type EmbeddingQueryResult =
  { readonly embedding: Int8Array; readonly fallback: null } | { readonly embedding: null; readonly fallback: EmbeddingQueryFallback };

/** Query-backed, single-flight indexer. Completed rows are the resume cursor. */
export class EmbeddingService {
  private phase: EmbeddingPhase = 'disabled';
  private userPaused = false;
  private download: ModelDownloadProgress = { downloadedBytes: 0, totalBytes: 0, asset: '' };
  private error: string | null = null;
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;
  private restartRequested = false;
  private closed = false;
  private lastDownloadPublishAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: EmbeddingServiceOptions) {}

  status(): EmbeddingStatus {
    const index = this.options.repository.status(EMBEDDING_MODEL_MANIFEST.version);
    const automaticPause = this.options.pauseReason();
    const available = this.options.available !== false;
    return {
      ...index,
      phase: available ? this.phase : 'unavailable',
      pauseReason: this.userPaused ? 'user' : automaticPause,
      modelVersion: EMBEDDING_MODEL_MANIFEST.version,
      downloadedBytes: this.download.downloadedBytes,
      downloadBytes: this.download.totalBytes,
      error: available ? this.error : (this.options.unavailableReason ?? 'semantic indexing is unavailable on this system'),
    };
  }

  start(): void {
    if (this.options.available === false) {
      this.publish();
      return;
    }
    if (!this.options.enabled() || this.closed) {
      this.phase = 'disabled';
      this.publish();
      return;
    }
    this.schedule();
  }

  enable(): EmbeddingStatus {
    if (this.closed) throw new Error('embedding service is closed');
    if (this.options.available === false) return this.status();
    this.options.setEnabled(true);
    this.options.repository.clearDeferred(EMBEDDING_MODEL_MANIFEST.version);
    this.userPaused = false;
    this.phase = 'downloading';
    this.error = null;
    this.publish();
    this.schedule();
    return this.status();
  }

  disable(): EmbeddingStatus {
    this.options.setEnabled(false);
    this.userPaused = false;
    this.restartRequested = false;
    this.controller?.abort();
    this.phase = 'disabled';
    this.error = null;
    this.publish();
    return this.status();
  }

  pause(): EmbeddingStatus {
    if (this.options.available === false) return this.status();
    this.userPaused = true;
    this.restartRequested = false;
    this.controller?.abort();
    this.phase = 'paused';
    this.publish();
    return this.status();
  }

  resume(): EmbeddingStatus {
    if (this.options.available === false) return this.status();
    if (!this.options.enabled()) throw new Error('semantic indexing is disabled');
    this.userPaused = false;
    this.error = null;
    this.schedule();
    return this.status();
  }

  notifyWorkAvailable(): void {
    if (this.options.available !== false && this.options.enabled() && !this.userPaused) this.schedule();
  }

  notifyEligibilityChanged(photoIds: readonly string[]): void {
    if (this.options.available === false || photoIds.length === 0) return;
    this.options.repository.clearDeferred(EMBEDDING_MODEL_MANIFEST.version, photoIds);
    this.notifyWorkAvailable();
  }

  async query(text: string): Promise<EmbeddingQueryResult> {
    const status = this.status();
    if (status.phase === 'disabled') return { embedding: null, fallback: 'disabled' };
    if (status.phase === 'unavailable' || this.options.embedText === undefined) return { embedding: null, fallback: 'unavailable' };
    if (status.phase === 'error') return { embedding: null, fallback: 'error' };
    if (status.phase !== 'ready') return { embedding: null, fallback: 'indexing' };
    const controller = new AbortController();
    try {
      return { embedding: await this.options.embedText(text, controller.signal), fallback: null };
    } catch (error) {
      if (error instanceof EmbeddingPoolBusyError) return { embedding: null, fallback: 'busy' };
      return { embedding: null, fallback: 'error' };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    await this.running?.catch(() => undefined);
  }

  private schedule(): void {
    if (this.options.available === false || this.closed || this.userPaused || !this.options.enabled()) return;
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

  private async ensureAssets(): Promise<void> {
    this.phase = 'downloading';
    this.publishDownloadProgress(true);
    await this.options.assets.ensureInstalled(
      true,
      (progress) => {
        this.download = progress;
        this.publishDownloadProgress(progress.totalBytes > 0 && progress.downloadedBytes >= progress.totalBytes);
      },
      this.controller?.signal,
    );
    this.publishDownloadProgress(true);
  }

  private async run(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    try {
      if (!(await this.options.assets.installed())) await this.ensureAssets();
      this.options.repository.deleteStale(EMBEDDING_MODEL_MANIFEST.version);
      while (!controller.signal.aborted && this.options.enabled() && !this.userPaused) {
        const paused = this.options.pauseReason();
        if (paused !== null) {
          this.phase = 'paused';
          this.publish();
          await delay(this.options.pausePollMs ?? 500, undefined, { signal: controller.signal });
          continue;
        }
        const candidate = this.options.repository.pending(EMBEDDING_MODEL_MANIFEST.version, 1)[0];
        if (candidate === undefined) {
          this.options.repository.deleteOtherModels(EMBEDDING_MODEL_MANIFEST.version);
          this.phase = 'ready';
          this.publish();
          return;
        }
        this.phase = 'indexing';
        this.publish();
        const bytes = await this.options.load(candidate, controller.signal);
        if (bytes === null) {
          this.options.repository.defer(candidate, EMBEDDING_MODEL_MANIFEST.version, 'derivative-unavailable');
          this.publish();
          continue;
        }
        try {
          const embedding = await this.options.embed(bytes, controller.signal);
          if (embedding === null) {
            this.options.repository.defer(candidate, EMBEDDING_MODEL_MANIFEST.version, 'derivative-unavailable');
            this.publish();
            continue;
          }
          try {
            this.options.repository.put(candidate, EMBEDDING_MODEL_MANIFEST.version, embedding);
          } catch (error) {
            if (!(error instanceof EmbeddingCandidateStaleError)) throw error;
          }
          embedding.fill(0);
        } finally {
          bytes.fill(0);
        }
        this.publish();
      }
    } catch (error) {
      if (controller.signal.aborted || this.closed || this.userPaused) return;
      this.error = error instanceof Error ? error.message : 'embedding failed';
      this.phase = 'error';
      this.publish();
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  private publish(): void {
    this.options.emit(this.status());
  }

  private publishDownloadProgress(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastDownloadPublishAt < (this.options.downloadPublishIntervalMs ?? 250)) return;
    this.lastDownloadPublishAt = now;
    this.publish();
  }
}
