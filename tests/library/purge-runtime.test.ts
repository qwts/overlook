import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPurgeRuntime } from '../../src/main/library/purge-runtime.js';

test('manual purge close aborts active work, rejects queued work, and drains before custody closes (#311)', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let activeSignal: AbortSignal | undefined;
  let calls = 0;
  const work: number[] = [];
  const runtime = createPurgeRuntime(
    {
      purge: async (_photoIds, signal) => {
        calls += 1;
        activeSignal = signal;
        await gate;
        return { purged: 1, skipped: 0, protected: 0, remoteFailures: 0 };
      },
      deletePermanently: () => Promise.resolve({ purged: 0, skipped: 0, protected: 0, remoteFailures: 0 }),
    },
    (delta) => work.push(delta),
  );

  const active = runtime.purge(['active']);
  const queued = runtime.purge(['queued']);
  await new Promise((resolve) => setImmediate(resolve));
  runtime.close();
  assert.equal(activeSignal?.aborted, true);
  let drained = false;
  const drain = runtime.drain().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false, 'shutdown waits for the active destructive item');
  release?.();

  assert.deepEqual(await active, { purged: 1, skipped: 0, protected: 0, remoteFailures: 0 });
  await assert.rejects(queued, /purge service is closed/);
  await drain;
  assert.equal(calls, 1, 'queued work never entered the purge service');
  assert.deepEqual(work, [1, -1], 'provider work stays locked for the full destructive operation');
  await assert.rejects(runtime.purge(['later']), /purge service is closed/);
});
