import { Worker } from 'node:worker_threads';

import type { EmbeddingWorkerData, EmbeddingWorkerRequest, EmbeddingWorkerResponse, EmbeddingWorkerShutdown } from './embedding-worker.js';

export interface EmbeddingPoolOptions extends EmbeddingWorkerData {
  readonly workerUrl: URL;
  /** Test override for the retire backstop. */
  readonly drainTimeoutMs?: number;
}

/** Hard-terminate backstop for retire(): only a wedged or already-broken
 * worker waits this long — a live one exits right after its in-flight run
 * settles. A backstop terminate can still hit the #843 abort, but a run
 * that has hung for this long has no safe teardown anyway. */
const DRAIN_TIMEOUT_MS = 10_000;

interface ActiveJob {
  readonly id: number;
  /** The worker the job was posted to — a retired worker's late exit must
   * only fail its own job, never a successor's (#843). */
  readonly worker: Worker;
  readonly resolve: (embedding: Int8Array) => void;
  readonly reject: (error: Error) => void;
  readonly removeAbort: (() => void) | undefined;
}

export class EmbeddingInputError extends Error {
  override readonly name = 'EmbeddingInputError';
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('embedding job aborted');
}

/** One worker by construction: indexing never competes with the import pool. */
export class EmbeddingPool {
  private worker: Worker | undefined;
  private active: ActiveJob | undefined;
  /** Retirements still draining (abort detaches fire-and-forget); close()
   * must await them so library teardown never outruns a live ONNX worker. */
  private readonly retiring = new Set<Promise<void>>();
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
              // Reject the job now, but retire the worker cooperatively:
              // terminate() mid-inference aborts the entire app (#843) —
              // onnxruntime's completion callback throws into the torn-down
              // worker env and the C++ exception escapes to std::terminate.
              this.fail(abortError(signal));
              void this.retire(worker);
            };
      if (onAbort !== undefined) signal?.addEventListener('abort', onAbort, { once: true });
      this.active = {
        id,
        worker,
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
    if (this.worker !== undefined) void this.retire(this.worker);
    // Await EVERY outstanding retirement, not just the current worker: an
    // abort may have detached a still-draining worker earlier, and teardown
    // must not proceed while any ONNX run is alive (PR #845 review).
    while (this.retiring.size > 0) {
      await Promise.all([...this.retiring]);
    }
  }

  /** Cooperative shutdown (#843): detach the worker (a new job gets a fresh
   * one), ask it to exit once its in-flight run settles, and hard-terminate
   * only a worker that never does. Resolves when the worker is gone. */
  private retire(worker: Worker): Promise<void> {
    if (this.worker === worker) this.worker = undefined;
    const drained = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void worker.terminate().then(() => resolve());
      }, this.options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS);
      timer.unref();
      worker.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      worker.postMessage({ shutdown: true } satisfies EmbeddingWorkerShutdown);
    });
    this.retiring.add(drained);
    void drained.finally(() => this.retiring.delete(drained));
    return drained;
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
      else job.reject(response.kind === 'input' ? new EmbeddingInputError(response.error) : new Error(response.error));
    });
    worker.on('error', (error: Error) => {
      if (this.active?.worker === worker) this.fail(error);
    });
    worker.on('exit', (code) => {
      // A retired worker's late exit must not clear its replacement or fail
      // a job that belongs to it.
      if (this.worker === worker) this.worker = undefined;
      if (this.active?.worker === worker) this.fail(new Error(`embedding worker exited with code ${String(code)}`));
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
