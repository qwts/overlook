import { Worker } from 'node:worker_threads';

import type { HistogramData } from '../../shared/library/histogram.js';
import type { HistogramJobRequest, HistogramJobResponse } from './histogram-worker.js';

// One lazily spawned worker thread for histogram jobs (#498). A histogram is
// a per-photo lookup, not a batch, so jobs run strictly in order on a single
// worker that is respawned if it dies; the job in flight when it dies is
// rejected, never lost. Undecodable bytes reject with HistogramDecodeError —
// an expected outcome the service reports as "corrupt", not a crash.

export class HistogramDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistogramDecodeError';
  }
}

interface Job {
  readonly bytes: Buffer;
  readonly resolve: (histogram: HistogramData) => void;
  readonly reject: (error: Error) => void;
}

export interface HistogramRunnerOptions {
  readonly workerUrl: URL;
}

export class HistogramRunner {
  private worker: Worker | null = null;
  private current: { readonly jobId: number; readonly job: Job } | null = null;
  private readonly queue: Job[] = [];
  private lastError: Error | undefined;
  private nextJobId = 1;
  private closed = false;

  constructor(private readonly options: HistogramRunnerOptions) {}

  compute(bytes: Buffer): Promise<HistogramData> {
    if (this.closed) return Promise.reject(new Error('histogram runner is closed'));
    return new Promise<HistogramData>((resolve, reject) => {
      this.queue.push({ bytes, resolve, reject });
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new Error('histogram runner is closed'));
    const worker = this.worker;
    this.worker = null;
    if (worker !== null) await worker.terminate();
  }

  private pump(): void {
    if (this.closed || this.current !== null) return;
    const job = this.queue.shift();
    if (job === undefined) return;
    const worker = this.ensureWorker();
    const jobId = this.nextJobId;
    this.nextJobId += 1;
    this.current = { jobId, job };
    worker.postMessage({ jobId, bytes: job.bytes } satisfies HistogramJobRequest);
  }

  private ensureWorker(): Worker {
    if (this.worker !== null) return this.worker;
    const worker = new Worker(this.options.workerUrl);
    worker.on('message', (response: HistogramJobResponse) => this.settle(worker, response));
    worker.on('error', (error: Error) => {
      this.lastError = error;
    });
    worker.on('exit', (code: number) => this.exited(worker, code));
    this.worker = worker;
    return worker;
  }

  private settle(worker: Worker, response: HistogramJobResponse): void {
    if (this.worker !== worker || this.current === null || this.current.jobId !== response.jobId) return;
    const { job } = this.current;
    this.current = null;
    if (response.ok && response.histogram !== undefined) job.resolve(response.histogram);
    else job.reject(new HistogramDecodeError(response.error ?? 'derivative did not decode'));
    this.pump();
  }

  private exited(worker: Worker, code: number): void {
    if (this.worker === worker) this.worker = null;
    const cause = this.lastError;
    this.lastError = undefined;
    const current = this.current;
    if (current !== null) {
      this.current = null;
      current.job.reject(new Error(`histogram worker exited with code ${String(code)}${cause === undefined ? '' : `: ${cause.message}`}`));
    }
    if (!this.closed) this.pump();
  }
}
