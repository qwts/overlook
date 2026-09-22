import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
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
