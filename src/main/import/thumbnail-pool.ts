import { Worker } from 'node:worker_threads';

import { embeddedJpegFromRaf } from './raf-preview.js';
import { resolveHeicPreview } from './heic-preview.js';
import { resolveRawPreview } from './raw-preview.js';
import type { ThumbJobRequest, ThumbJobResponse } from './thumbnail-worker.js';
import type { FileKind } from '../../shared/library/types.js';
import type { EditTransform } from '../../shared/library/edit-revision.js';
import type { PreviewFailureReason } from '../../shared/library/preview.js';

// Bounded worker pool (#86): sharp runs off the main thread per ADR-0006.
// Each worker carries permanent message/exit listeners and at most one
// current job — a crash rejects only that job and corrects the pool's
// accounting whether the worker was busy OR idle, so the queue never hangs
// and the pool never leaks capacity. Cancellation drains queued jobs
// without spending worker time.

export interface ThumbnailDerivatives {
  readonly thumb: Buffer;
  readonly mid: Buffer;
  readonly width: number | null;
  readonly height: number | null;
}

export interface ThumbnailFailure {
  readonly failure: PreviewFailureReason;
}

export type ThumbnailPoolResult = ThumbnailDerivatives | ThumbnailFailure | null;

interface Job {
  readonly bytes: Buffer;
  readonly wipe: boolean;
  readonly transform: EditTransform | undefined;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (result: ThumbnailDerivatives | null) => void;
  readonly reject: (error: Error) => void;
}

interface CurrentJob {
  readonly jobId: number;
  readonly job: Job;
  readonly abort: (() => void) | undefined;
}

export interface ThumbnailPoolOptions {
  /** Worker entry URL — production passes the bundled worker, tests the compiled one. */
  readonly workerUrl: URL;
  /** Bounded parallelism. Default 2. */
  readonly size?: number | undefined;
}

export class ThumbnailPool {
  private readonly workerUrl: URL;
  private readonly size: number;
  private readonly workers = new Set<Worker>();
  private readonly idle: Worker[] = [];
  private readonly current = new Map<Worker, CurrentJob>();
  private readonly lastError = new Map<Worker, Error>();
  private readonly queue: Job[] = [];
  private nextJobId = 1;
  private closed = false;

  constructor(options: ThumbnailPoolOptions) {
    this.workerUrl = options.workerUrl;
    this.size = options.size ?? 2;
  }

  /**
   * Decodable-image derivatives per ADR-0006, or null when the bytes are not
   * decodable (the placeholder contract) or the job was cancelled. RAW
   * containers resolve a validated embedded or native preview first; no usable
   * preview is a placeholder, never a failed import.
   */
  generate(
    bytes: Buffer,
    signal?: AbortSignal,
    fileKind?: Exclude<FileKind, 'heic'>,
    transform?: EditTransform,
  ): Promise<ThumbnailDerivatives | null>;
  generate(bytes: Buffer, signal: AbortSignal | undefined, fileKind: 'heic', transform?: EditTransform): Promise<ThumbnailPoolResult>;
  generate(
    bytes: Buffer,
    signal: AbortSignal | undefined,
    fileKind: FileKind | undefined,
    transform?: EditTransform,
  ): Promise<ThumbnailPoolResult>;
  async generate(bytes: Buffer, signal?: AbortSignal, fileKind?: FileKind, transform?: EditTransform): Promise<ThumbnailPoolResult> {
    if (this.closed) {
      throw new Error('thumbnail pool is closed');
    }
    if (signal?.aborted === true) {
      return null;
    }
    const heic = fileKind === 'heic' ? await resolveHeicPreview(bytes, { signal }) : null;
    if (fileKind === 'heic' && heic === null) return null;
    if (heic !== null && !heic.ok) return { failure: heic.reason };
    const raw = fileKind !== 'heic' && (fileKind === 'raw' || embeddedJpegFromRaf(bytes) !== null);
    const rawPreview = raw ? await resolveRawPreview(bytes, { signal }) : null;
    if (raw && rawPreview === null) return null;
    const preview = heic?.ok === true ? heic.preview : rawPreview;
    const target = preview?.bytes ?? bytes;
    return new Promise<ThumbnailDerivatives | null>((resolve, reject) => {
      this.queue.push({ bytes: target, wipe: preview !== null, transform, signal, resolve, reject });
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    // Jobs still queued would otherwise never settle (nothing pumps after
    // close) — reject them before tearing the workers down.
    for (const job of this.queue.splice(0)) {
      if (job.wipe) job.bytes.fill(0);
      job.reject(new Error('thumbnail pool is closed'));
    }
    await Promise.all([...this.workers].map(async (worker) => worker.terminate()));
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const job = this.queue[0];
      if (job === undefined) {
        return;
      }
      if (job.signal?.aborted === true) {
        this.queue.shift();
        if (job.wipe) job.bytes.fill(0);
        job.resolve(null);
        continue;
      }
      const worker = this.checkout();
      if (worker === null) {
        return; // At capacity — the next completion or exit re-pumps.
      }
      this.queue.shift();
      this.dispatch(worker, job);
    }
  }

  private checkout(): Worker | null {
    const worker = this.idle.pop();
    if (worker !== undefined) {
      return worker;
    }
    if (this.workers.size >= this.size) {
      return null;
    }
    return this.spawn();
  }

  private spawn(): Worker {
    const worker = new Worker(this.workerUrl);
    this.workers.add(worker);
    worker.on('message', (response: ThumbJobResponse) => {
      this.onMessage(worker, response);
    });
    // An unhandled 'error' event is rethrown on the main process (e.g. sharp
    // failing at module init). Consume it here; the 'exit' that follows does
    // the recovery, carrying this error as the rejection's cause.
    worker.on('error', (error: unknown) => {
      this.lastError.set(worker, error instanceof Error ? error : new Error(String(error)));
    });
    worker.on('exit', (code: number) => {
      this.onExit(worker, code);
    });
    return worker;
  }

  private onMessage(worker: Worker, response: ThumbJobResponse): void {
    const entry = this.current.get(worker);
    if (entry === undefined || entry.jobId !== response.jobId) {
      return;
    }
    this.current.delete(worker);
    entry.abort?.();
    if (entry.job.wipe) entry.job.bytes.fill(0);
    if (entry.job.signal?.aborted === true || !response.ok) {
      // Undecodable bytes → placeholder marker, not a failure (E5.3); a
      // cancelled batch drops its in-flight result the same way.
      entry.job.resolve(null);
    } else {
      entry.job.resolve({
        thumb: Buffer.from(response.thumb ?? new Uint8Array()),
        mid: Buffer.from(response.mid ?? new Uint8Array()),
        width: response.width ?? null,
        height: response.height ?? null,
      });
    }
    this.idle.push(worker);
    this.pump();
  }

  private onExit(worker: Worker, code: number): void {
    // Fires for busy AND idle workers: correct the books either way, reject
    // only the crashed worker's own job, and respawn lazily via pump().
    this.workers.delete(worker);
    const idleAt = this.idle.indexOf(worker);
    if (idleAt !== -1) {
      this.idle.splice(idleAt, 1);
    }
    const cause = this.lastError.get(worker);
    this.lastError.delete(worker);
    const entry = this.current.get(worker);
    if (entry !== undefined) {
      this.current.delete(worker);
      entry.abort?.();
      if (entry.job.wipe) entry.job.bytes.fill(0);
      if (entry.job.signal?.aborted === true) entry.job.resolve(null);
      else
        entry.job.reject(new Error(`thumbnail worker exited with code ${String(code)}${cause === undefined ? '' : `: ${cause.message}`}`));
    }
    if (!this.closed) {
      this.pump();
    }
  }

  private dispatch(worker: Worker, job: Job): void {
    const jobId = this.nextJobId;
    this.nextJobId += 1;
    const onAbort = job.signal === undefined ? undefined : () => void worker.terminate();
    if (onAbort !== undefined) job.signal?.addEventListener('abort', onAbort, { once: true });
    const removeAbort =
      onAbort === undefined || job.signal === undefined ? undefined : () => job.signal?.removeEventListener('abort', onAbort);
    this.current.set(worker, { jobId, job, abort: removeAbort });
    worker.postMessage({ jobId, bytes: job.bytes, transform: job.transform } satisfies ThumbJobRequest);
  }
}
