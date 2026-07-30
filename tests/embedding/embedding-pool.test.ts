import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EmbeddingPool } from '../../src/main/embedding/embedding-pool.js';

// #843: terminate() while an ONNX run is in flight aborts the entire app —
// onnxruntime's completion callback throws into the torn-down worker env and
// the C++ exception escapes to std::terminate. The pool must retire workers
// cooperatively (shutdown message, exit after the in-flight job settles) and
// hard-terminate only a worker that never exits. Scripted data: workers stand
// in for the real ONNX worker so the drain protocol is testable.

function poolWith(source: string, drainTimeoutMs?: number): EmbeddingPool {
  return new EmbeddingPool({
    workerUrl: new URL(`data:text/javascript,${encodeURIComponent(source)}`),
    modelPath: 'unused-by-scripted-worker',
    providers: ['cpu'],
    ...(drainTimeoutMs === undefined ? {} : { drainTimeoutMs }),
  });
}

/** Mirrors the real worker's shutdown contract: respond after a delay
 * (simulated in-flight inference), exit only once the current job settles. */
const COOPERATIVE_WORKER = `
import { parentPort } from 'node:worker_threads';
let current = Promise.resolve();
parentPort.on('message', (message) => {
  if (message.shutdown) { current.then(() => process.exit(0), () => process.exit(0)); return; }
  current = new Promise((resolve) => setTimeout(resolve, 150)).then(() => {
    parentPort.postMessage({ jobId: message.jobId, ok: true, embedding: new Int8Array([1, 2, 3]), provider: 'scripted' });
  });
});
`;

/** A wedged worker: never responds, ignores shutdown. */
const STUBBORN_WORKER = `
import { parentPort } from 'node:worker_threads';
parentPort.on('message', () => {});
`;

describe('embedding pool worker retirement (#843)', () => {
  test('ACCEPTANCE: close() during an in-flight job lets it finish — no mid-run terminate', async () => {
    const pool = poolWith(COOPERATIVE_WORKER);
    const job = pool.embed(Buffer.from([1]));
    await pool.close();
    // Before the fix, close() terminated mid-run and this rejected with
    // "embedding worker exited"; the packaged app died with SIGABRT instead.
    assert.deepEqual(await job, new Int8Array([1, 2, 3]));
  });

  test('abort rejects the job immediately and the pool recovers with a fresh worker', async () => {
    const pool = poolWith(COOPERATIVE_WORKER);
    const controller = new AbortController();
    const aborted = pool.embed(Buffer.from([1]), controller.signal);
    controller.abort(new Error('switching library'));
    await assert.rejects(aborted, /switching library/);

    // The retired worker drains in the background; new work gets a fresh one.
    assert.deepEqual(await pool.embed(Buffer.from([2])), new Int8Array([1, 2, 3]));
    await pool.close();
  });

  test('REGRESSION (PR #845): close() awaits a worker already detached by an earlier abort', async () => {
    const pool = poolWith(COOPERATIVE_WORKER);
    const controller = new AbortController();
    const aborted = pool.embed(Buffer.from([1]), controller.signal);
    controller.abort(new Error('teardown'));
    await assert.rejects(aborted, /teardown/);

    // The aborted worker is detached and draining in the background; close()
    // must not resolve while it is still alive — teardown would otherwise
    // outrun a live ONNX run.
    await pool.close();
    assert.equal((pool as unknown as { retiring: Set<Promise<void>> }).retiring.size, 0, 'no retirement is still draining after close()');
  });

  test('a worker that never exits is hard-terminated by the backstop', async () => {
    const pool = poolWith(STUBBORN_WORKER, 100);
    const job = pool.embed(Buffer.from([1]));
    await pool.close();
    await assert.rejects(job, /embedding worker exited/);
  });

  test('a closed pool refuses new work', async () => {
    const pool = poolWith(COOPERATIVE_WORKER);
    await pool.close();
    await assert.rejects(pool.embed(Buffer.from([1])), /closed/);
  });
});
