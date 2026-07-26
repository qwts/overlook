import { Worker } from 'node:worker_threads';

import type { EmbeddingWorkerData, EmbeddingWorkerRequest, EmbeddingWorkerResponse } from './embedding-worker.js';

export interface EmbeddingPoolOptions extends EmbeddingWorkerData {
  readonly workerUrl: URL;
}

interface ActiveJob {
  readonly id: number;
  readonly resolve: (embedding: Int8Array) => void;
  readonly reject: (error: Error) => void;
  readonly removeAbort: (() => void) | undefined;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('embedding job aborted');
}

/** One worker by construction: indexing never competes with the import pool. */
export class EmbeddingPool {
  private worker: Worker | undefined;
  private active: ActiveJob | undefined;
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: EmbeddingPoolOptions) {}

  embed(bytes: Buffer, signal?: AbortSignal): Promise<Int8Array> {
    if (this.closed) return Promise.reject(new Error('embedding pool is closed'));
    if (this.active !== undefined) return Promise.reject(new Error('embedding pool accepts one job at a time'));
    if (signal?.aborted === true) return Promise.reject(abortError(signal));
    const worker = this.getWorker();
    const id = this.nextId++;
    return new Promise<Int8Array>((resolve, reject) => {
      const onAbort =
        signal === undefined
          ? undefined
          : () => {
              void worker.terminate();
            };
      if (onAbort !== undefined) signal?.addEventListener('abort', onAbort, { once: true });
      this.active = {
        id,
        resolve,
        reject,
        removeAbort: onAbort === undefined || signal === undefined ? undefined : () => signal.removeEventListener('abort', onAbort),
      };
      const transferred = new Uint8Array(bytes);
      worker.postMessage({ jobId: id, bytes: transferred } satisfies EmbeddingWorkerRequest, [transferred.buffer]);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = undefined;
    if (worker !== undefined) await worker.terminate();
  }

  private getWorker(): Worker {
    if (this.worker !== undefined) return this.worker;
    const worker = new Worker(this.options.workerUrl, {
      workerData: { modelPath: this.options.modelPath, providers: this.options.providers } satisfies EmbeddingWorkerData,
    });
    worker.on('message', (response: EmbeddingWorkerResponse) => {
      const job = this.active;
      if (job === undefined || response.jobId !== job.id) return;
      this.active = undefined;
      job.removeAbort?.();
      if (response.ok) job.resolve(new Int8Array(response.embedding));
      else job.reject(new Error(response.error));
    });
    worker.on('error', (error: Error) => {
      this.fail(error);
    });
    worker.on('exit', (code) => {
      this.worker = undefined;
      if (this.active !== undefined) this.fail(new Error(`embedding worker exited with code ${String(code)}`));
    });
    this.worker = worker;
    return worker;
  }

  private fail(error: Error): void {
    const job = this.active;
    if (job === undefined) return;
    this.active = undefined;
    job.removeAbort?.();
    job.reject(error);
  }
}
