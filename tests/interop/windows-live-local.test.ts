import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as pause } from 'node:timers/promises';
import { type Worker } from 'node:worker_threads';
import { describe, test } from 'node:test';

import { LIVE_LOCAL_CONTROL_FRAME_BYTES, LiveLocalError } from '../../src/main/interop/live-local-security.js';
import {
  createWindowsLiveLocalPlatform,
  type WindowsLiveLocalDependencies,
  type WindowsPipeBinding,
} from '../../src/main/interop/windows-live-local.js';

const ENDPOINT = String.raw`\\.\pipe\com.qwts.overlook.interop-test`;
const SID = 'S-1-5-21-111-222-333-1001';
const SDDL = `D:P(A;;FA;;;${SID})`;

class FakeWorker extends EventEmitter {
  threadId = 1;
  readonly posted: unknown[] = [];
  terminateCount = 0;
  onPost: ((value: unknown) => void) | undefined;

  postMessage(value: unknown): void {
    this.posted.push(value);
    this.onPost?.(value);
  }

  terminate(): Promise<number> {
    this.terminateCount += 1;
    this.threadId = -1;
    return Promise.resolve(0);
  }
}

interface WorkerRecord {
  readonly filename: URL;
  readonly workerData: unknown;
  readonly worker: FakeWorker;
}

function binding(overrides: Partial<WindowsPipeBinding> = {}): WindowsPipeBinding {
  return {
    canonicalizeSddl: (value) => value,
    currentUserSid: () => SID,
    ...overrides,
  };
}

function harness(
  pipeBinding: WindowsPipeBinding = binding(),
  configure?: (record: WorkerRecord) => void,
): { readonly dependencies: WindowsLiveLocalDependencies; readonly records: WorkerRecord[] } {
  const records: WorkerRecord[] = [];
  return {
    records,
    dependencies: {
      loadBinding: () => pipeBinding,
      createWorker: (filename, workerData) => {
        const worker = new FakeWorker();
        const record = { filename, workerData, worker };
        records.push(record);
        configure?.(record);
        return worker as unknown as Worker;
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function workerData(record: WorkerRecord): Record<string, unknown> {
  assert.ok(isRecord(record.workerData));
  return record.workerData;
}

function firstRecord(records: readonly WorkerRecord[]): WorkerRecord {
  const record = records[0];
  assert.ok(record);
  return record;
}

function hasErrorCode(value: unknown, code: string): boolean {
  return value instanceof Error && 'code' in value && value.code === code;
}

describe('Windows live local worker orchestration (#1066)', () => {
  test('uses the current SID and bounded client worker request', async () => {
    const setup = harness(binding(), ({ worker }) => {
      queueMicrotask(() =>
        worker.emit('message', {
          type: 'response',
          payload: Buffer.from(JSON.stringify({ schemaVersion: 1, ok: true }), 'utf8'),
        }),
      );
    });
    const platform = createWindowsLiveLocalPlatform(setup.dependencies);

    assert.equal(platform.currentUserSid(), SID);
    assert.deepEqual(await platform.request(ENDPOINT, { operation: 'bootstrap' }), { schemaVersion: 1, ok: true });
    assert.equal(setup.records.length, 1);
    const record = firstRecord(setup.records);
    assert.equal(record.filename.pathname.endsWith('/windows-pipe-client-worker.js'), true);
    assert.deepEqual(workerData(record), {
      endpoint: ENDPOINT,
      serverSid: SID,
      payload: Buffer.from(JSON.stringify({ operation: 'bootstrap' }), 'utf8'),
      maxFrameBytes: LIVE_LOCAL_CONTROL_FRAME_BYTES,
      timeoutMs: 5_000,
    });
    assert.equal(record.worker.terminateCount, 1);
  });

  test('rejects unavailable identity and invalid or oversized request JSON before spawning', async () => {
    const invalidIdentity = harness(binding({ currentUserSid: () => 'not-a-sid' }));
    const invalidPlatform = createWindowsLiveLocalPlatform(invalidIdentity.dependencies);
    assert.throws(
      () => invalidPlatform.currentUserSid(),
      (error: unknown) => hasErrorCode(error, 'unsupported'),
    );
    assert.throws(
      () => invalidPlatform.request(ENDPOINT, {}),
      (error: unknown) => hasErrorCode(error, 'unsupported'),
    );
    assert.equal(invalidIdentity.records.length, 0);

    const setup = harness();
    const platform = createWindowsLiveLocalPlatform(setup.dependencies);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await assert.rejects(platform.request(ENDPOINT, cyclic), (error: unknown) => hasErrorCode(error, 'corrupt'));
    await assert.rejects(platform.request(ENDPOINT, 'x'.repeat(LIVE_LOCAL_CONTROL_FRAME_BYTES + 1)), (error: unknown) =>
      hasErrorCode(error, 'over-budget'),
    );
    assert.equal(setup.records.length, 0);
  });

  test('maps client worker protocol, parse, error, and premature-exit failures', async () => {
    const messages: Array<(worker: FakeWorker) => void> = [
      (worker) => worker.emit('message', { type: 'error', code: 'not-running', message: 'not running' }),
      (worker) => worker.emit('message', { type: 'response', payload: Buffer.from('not json') }),
      (worker) => worker.emit('message', { type: 'unexpected' }),
      (worker) => worker.emit('error', 'worker failed'),
      (worker) => worker.emit('exit', 9),
    ];
    const setup = harness(binding(), ({ worker }) => {
      const next = messages.shift();
      assert.ok(next);
      queueMicrotask(() => next(worker));
    });
    const platform = createWindowsLiveLocalPlatform(setup.dependencies);

    await assert.rejects(platform.request(ENDPOINT, {}), (error: unknown) => hasErrorCode(error, 'ENOENT'));
    await assert.rejects(platform.request(ENDPOINT, {}), (error: unknown) => hasErrorCode(error, 'corrupt'));
    await assert.rejects(platform.request(ENDPOINT, {}), /named-pipe request failed/u);
    await assert.rejects(platform.request(ENDPOINT, {}), /worker failed/u);
    await assert.rejects(platform.request(ENDPOINT, {}), /exited with code 9/u);
    assert.equal(
      setup.records.every(({ worker }) => worker.terminateCount === 1),
      true,
    );
  });

  test('validates server DACL, dispatches replies, and closes once', async () => {
    const setup = harness(binding(), ({ worker }) => {
      worker.onPost = (value) => {
        if (isRecord(value) && value['type'] === 'close') {
          worker.threadId = -1;
          queueMicrotask(() => worker.emit('exit', 0));
        }
      };
      queueMicrotask(() => worker.emit('message', { type: 'ready', securityDescriptor: SDDL }));
    });
    const platform = createWindowsLiveLocalPlatform(setup.dependencies);
    const server = await platform.start(ENDPOINT, SDDL, (value) => ({ echoed: value }));
    const record = firstRecord(setup.records);
    assert.equal(record.filename.pathname.endsWith('/windows-pipe-worker.js'), true);
    assert.deepEqual(workerData(record), {
      endpoint: ENDPOINT,
      sddl: SDDL,
      maxFrameBytes: LIVE_LOCAL_CONTROL_FRAME_BYTES,
    });

    record.worker.emit('message', { type: 'request', id: 7, payload: Buffer.from(JSON.stringify({ hello: 'world' })) });
    record.worker.emit('message', { type: 'ignored', id: 8, payload: Buffer.from('{}') });
    await pause();
    assert.deepEqual(record.worker.posted[0], {
      type: 'response',
      id: 7,
      payload: Buffer.from(JSON.stringify({ schemaVersion: 1, ok: true, result: { echoed: { hello: 'world' } } })),
    });

    await server.close();
    await server.close();
    assert.deepEqual(record.worker.posted.at(-1), { type: 'close' });
    assert.equal(record.worker.terminateCount, 0);
  });

  test('contains corrupt, rejected, and oversized server responses', async () => {
    const handlers: Array<(value: unknown) => unknown> = [
      () => {
        throw new LiveLocalError('bad request', 'corrupt');
      },
      () => {
        throw new Error('handler failed');
      },
      () => 'x'.repeat(LIVE_LOCAL_CONTROL_FRAME_BYTES + 1),
    ];
    const setup = harness(binding(), ({ worker }) => {
      queueMicrotask(() => worker.emit('message', { type: 'ready', securityDescriptor: SDDL }));
    });
    const platform = createWindowsLiveLocalPlatform(setup.dependencies);
    const server = await platform.start(ENDPOINT, SDDL, (value) => {
      const next = handlers.shift();
      assert.ok(next);
      return next(value);
    });
    const worker = firstRecord(setup.records).worker;

    worker.emit('message', { type: 'request', id: 1, payload: Buffer.from('{}') });
    worker.emit('message', { type: 'request', id: 2, payload: Buffer.from('{}') });
    worker.emit('message', { type: 'request', id: 3, payload: Buffer.from('{}') });
    worker.emit('message', { type: 'request', id: 4, payload: Buffer.from('not json') });
    await pause();
    await pause();

    const replies = worker.posted.map((value) => {
      assert.ok(isRecord(value));
      const payload = value['payload'];
      assert.ok(payload instanceof Uint8Array);
      return JSON.parse(Buffer.from(payload).toString('utf8')) as unknown;
    });
    assert.deepEqual(replies, [
      { schemaVersion: 1, ok: false, code: 'corrupt', retryable: false },
      { schemaVersion: 1, ok: false, code: 'unsupported', retryable: false },
      { schemaVersion: 1, ok: false, code: 'unsupported', retryable: false },
      { schemaVersion: 1, ok: false, code: 'unsupported', retryable: false },
    ]);
    worker.threadId = -1;
    worker.emit('exit', 0);
    await server.close();
  });

  test('rejects invalid or mismatched server security state and worker startup failures', async () => {
    const unavailable = harness(binding({ canonicalizeSddl: () => undefined }));
    await assert.rejects(
      createWindowsLiveLocalPlatform(unavailable.dependencies).start(ENDPOINT, SDDL, () => undefined),
      (error: unknown) => hasErrorCode(error, 'unsupported'),
    );
    assert.equal(unavailable.records.length, 0);

    const failures: Array<(worker: FakeWorker) => void> = [
      (worker) => worker.emit('message', { type: 'ready', securityDescriptor: 'different' }),
      (worker) => worker.emit('message', { type: 'fatal', message: 'native failed' }),
      (worker) => worker.emit('error', 'worker failed'),
      (worker) => worker.emit('exit', 2),
    ];
    const patterns = [/DACL does not match/u, /native failed/u, /worker failed/u, /exited with code 2/u];
    const setup = harness(binding(), ({ worker }) => {
      const next = failures.shift();
      assert.ok(next);
      queueMicrotask(() => next(worker));
    });
    const platform = createWindowsLiveLocalPlatform(setup.dependencies);
    for (const pattern of patterns)
      await assert.rejects(
        platform.start(ENDPOINT, SDDL, () => undefined),
        pattern,
      );
    assert.equal(
      setup.records.every(({ worker }) => worker.terminateCount === 1),
      true,
    );
  });
});
