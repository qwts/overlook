'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createConnection } = require('node:net');
const { join } = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { Worker } = require('node:worker_threads');

const binding = require('./pipe.cjs');

const MAX_FRAME_BYTES = 64 * 1024;

function waitForMessage(worker, predicate) {
  return new Promise((resolve, reject) => {
    const message = (value) => {
      if (!predicate(value)) return;
      cleanup();
      resolve(value);
    };
    const error = (value) => {
      cleanup();
      reject(value);
    };
    const cleanup = () => {
      worker.off('message', message);
      worker.off('error', error);
    };
    worker.on('message', message);
    worker.on('error', error);
  });
}

test('real Windows pipe enforces the current-user DACL, one owner, and bounded framing', async (context) => {
  assert.equal(process.platform, 'win32');
  const sid = binding.currentUserSid();
  assert.match(sid, /^S-1-(?:\d+-){1,14}\d+$/u);
  const endpoint = `\\\\.\\pipe\\com.qwts.overlook.interop-test-${process.pid}-${randomUUID()}`;
  const sddl = `D:P(A;;FA;;;${sid})`;
  const worker = new Worker(join(__dirname, 'test-worker.cjs'), {
    workerData: { endpoint, sddl, maxFrameBytes: MAX_FRAME_BYTES },
  });
  context.after(async () => {
    worker.postMessage({ type: 'close' });
    await waitForMessage(worker, (message) => message?.type === 'closed').catch(() => undefined);
    await worker.terminate();
  });

  const ready = await waitForMessage(worker, (message) => message?.type === 'ready');
  assert.equal(ready.securityDescriptor, binding.canonicalizeSddl(sddl));
  assert.throws(() => new binding.PipeServer(endpoint, sddl, MAX_FRAME_BYTES), /CreateNamedPipeW/u);

  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, state: 'locked' }), 'utf8');
  const firstDisconnect = waitForMessage(worker, (message) => message?.type === 'disconnected');
  assert.deepEqual(binding.request(endpoint, sid, payload, MAX_FRAME_BYTES, 500), payload);
  await firstDisconnect;

  const rejectedDisconnect = waitForMessage(worker, (message) => message?.type === 'disconnected');
  assert.throws(() => binding.request(endpoint, 'S-1-5-18', payload, MAX_FRAME_BYTES, 500), /belongs to another user/u);
  await rejectedDisconnect;

  const oversized = waitForMessage(worker, (message) => message?.type === 'read-error');
  const hostile = createConnection(endpoint);
  await new Promise((resolve, reject) => {
    hostile.once('connect', resolve);
    hostile.once('error', reject);
  });
  const header = Buffer.alloc(4);
  header.writeUInt32LE(MAX_FRAME_BYTES + 1);
  hostile.write(header);
  assert.equal((await oversized).code, 'over-budget');
  hostile.destroy();

  const secondDisconnect = waitForMessage(worker, (message) => message?.type === 'disconnected');
  assert.deepEqual(binding.request(endpoint, sid, payload, MAX_FRAME_BYTES, 500), payload);
  await secondDisconnect;

  const timedOut = waitForMessage(worker, (message) => message?.type === 'read-error' && message?.code === 'timeout');
  const slow = createConnection(endpoint);
  await new Promise((resolve, reject) => {
    slow.once('connect', resolve);
    slow.once('error', reject);
  });
  const startedAt = Date.now();
  slow.write(Buffer.from([1]));
  await delay(300);
  slow.write(Buffer.from([0]));
  await timedOut;
  assert.ok(Date.now() - startedAt < 750, 'partial reads must share one absolute frame deadline');
  slow.destroy();
});

test('native-host registry cleanup removes only the exact manifest owner', (context) => {
  const manifest = `C:\\Users\\runneradmin\\AppData\\Roaming\\Overlook\\NativeMessagingHosts\\manifest-${randomUUID()}.json`;
  context.after(() => binding.unregisterNativeHost(manifest));
  assert.equal(binding.registerNativeHost(manifest), 4);
  assert.deepEqual(binding.nativeHostRegistryValues(), [manifest, manifest, manifest, manifest]);
  assert.equal(binding.unregisterNativeHost(`${manifest}.foreign`), 0);
  assert.deepEqual(binding.nativeHostRegistryValues(), [manifest, manifest, manifest, manifest]);
  assert.equal(binding.unregisterNativeHost(manifest), 4);
  assert.deepEqual(binding.nativeHostRegistryValues(), [null, null, null, null]);
});
