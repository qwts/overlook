import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import type { EmbeddingWorkerData, EmbeddingWorkerRequest, EmbeddingWorkerResponse } from '../../src/main/embedding/embedding-worker.js';
import sharp from 'sharp';

import { EMBEDDING_DIMENSIONS } from '../../src/main/db/embedding-repository.js';
import { EmbeddingPool } from '../../src/main/embedding/embedding-pool.js';
import { executionProviders } from '../../src/main/embedding/embedding-runtime.js';

async function solidImage(value: number): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: value, g: value, b: value } } })
    .png()
    .toBuffer();
}

for (const [name, providers] of [
  ['CPU floor', ['cpu']],
  ['platform provider preference', executionProviders(process.platform)],
  ['unavailable accelerator fallback', ['overlook-unavailable-test-provider', 'cpu']],
] as const) {
  test(`native embedding worker: ${name}, inference and cooperative close (#1170)`, { timeout: 20_000 }, async () => {
    const pool = new EmbeddingPool({
      workerUrl: new URL('../../src/main/embedding/embedding-worker.js', import.meta.url),
      modelPath: resolve('tests/fixtures/embedding/native-embedding.onnx'),
      providers,
      disableCpuFallback: name === 'platform provider preference' && process.platform !== 'linux',
    });
    try {
      const expected = new Int8Array(EMBEDDING_DIMENSIONS);
      expected[0] = 127;
      assert.deepEqual(await pool.embed(await solidImage(255)), expected);

      // Close while inference is in flight: the native completion callback must
      // settle before worker teardown (the historical #843 process-abort path).
      const pending = pool.embed(await solidImage(0));
      await pool.close();
      expected[0] = -127;
      assert.deepEqual(await pending, expected);
      await assert.rejects(pool.embed(Buffer.from([1])), /closed/u);
    } finally {
      await pool.close();
    }
  });
}

for (const [name, providers, expected, disableCpuFallback] of [
  [
    'platform provider',
    executionProviders(process.platform).slice(0, 1),
    executionProviders(process.platform)[0],
    process.platform !== 'linux',
  ],
  ['unavailable provider fallback', ['overlook-unavailable-test-provider', 'cpu'], 'cpu', false],
  ['CPU rejection with fallback disabled', ['cpu'], null, true],
] as const) {
  test(`native embedding worker reports the selected ${name} (#1170)`, { timeout: 20_000 }, async () => {
    const worker = new Worker(new URL('../../src/main/embedding/embedding-worker.js', import.meta.url), {
      workerData: {
        modelPath: resolve('tests/fixtures/embedding/native-embedding.onnx'),
        providers,
        disableCpuFallback,
      } satisfies EmbeddingWorkerData,
    });
    const exited = once(worker, 'exit');
    try {
      const response = new Promise<EmbeddingWorkerResponse>((resolveResponse, reject) => {
        worker.once('message', resolveResponse);
        worker.once('error', reject);
        worker.once('exit', (code) => reject(new Error(`worker exited before its response: ${String(code)}`)));
      });
      worker.postMessage({ jobId: 1, kind: 'image', bytes: new Uint8Array(await solidImage(255)) } satisfies EmbeddingWorkerRequest);
      const result = await response;
      if (expected === null) {
        assert.equal(result.ok, false, 'the native binding must enforce the CPU fallback option');
        if (!result.ok) assert.match(result.error, /CPU EP.*(?:disabled fallback|fallback.*disabled)/su);
      } else {
        assert.equal(result.ok, true, result.ok ? undefined : result.error);
        if (result.ok) assert.equal(result.provider, expected, 'CPU fallback cannot qualify a platform accelerator');
      }
    } finally {
      worker.postMessage({ shutdown: true });
      await exited;
    }
  });
}
