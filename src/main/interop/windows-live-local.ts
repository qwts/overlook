import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { Worker } from 'node:worker_threads';

import { requestSocketLiveLocalControl, type LiveLocalControlServer } from './live-local-control.js';
import { LIVE_LOCAL_CONTROL_FRAME_BYTES, LiveLocalError } from './live-local-security.js';

const nativeRequire = createRequire(import.meta.url);
const SID = /^S-1-(?:\d+-){1,14}\d+$/u;
const WORKER_CLOSE_MS = 6_000;

interface WindowsPipeBinding {
  currentUserSid(): unknown;
}

interface WorkerMessage {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly payload?: unknown;
  readonly securityDescriptor?: unknown;
  readonly message?: unknown;
}

export interface WindowsLiveLocalPlatform {
  currentUserSid(): string;
  start(endpoint: string, sddl: string, handle: (value: unknown) => unknown): Promise<LiveLocalControlServer>;
  request(endpoint: string, value: unknown): Promise<unknown>;
}

function loadBinding(): WindowsPipeBinding {
  return nativeRequire('@overlook/windows-interop/pipe.cjs') as WindowsPipeBinding;
}

function currentUserSid(): string {
  const sid = loadBinding().currentUserSid();
  if (typeof sid !== 'string' || !SID.test(sid)) {
    throw new LiveLocalError('Windows live local identity is unavailable.', 'unsupported');
  }
  return sid;
}

function encodedReply(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > LIVE_LOCAL_CONTROL_FRAME_BYTES) {
    throw new LiveLocalError('Windows live local response exceeds its bound.', 'over-budget');
  }
  return payload;
}

function controlFailure(error: unknown): Record<string, unknown> {
  if (error instanceof LiveLocalError && (error.code === 'corrupt' || error.code === 'over-budget')) {
    return { schemaVersion: 1, ok: false, code: 'corrupt', retryable: false };
  }
  return { schemaVersion: 1, ok: false, code: 'unsupported', retryable: false };
}

async function startWindowsLiveLocalControlServer(
  endpoint: string,
  sddl: string,
  handle: (value: unknown) => unknown,
): Promise<LiveLocalControlServer> {
  const worker = new Worker(new URL('./windows-pipe-worker.js', import.meta.url), {
    workerData: { endpoint, sddl, maxFrameBytes: LIVE_LOCAL_CONTROL_FRAME_BYTES },
  });
  let closed = false;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  worker.on('message', (message: WorkerMessage) => {
    if (message.type === 'ready') {
      if (message.securityDescriptor === sddl) readyResolve?.();
      else readyReject?.(new Error('Windows named-pipe DACL does not match the accepted security contract.'));
      return;
    }
    if (message.type === 'fatal') {
      readyReject?.(new Error(typeof message.message === 'string' ? message.message : 'Windows named-pipe worker failed.'));
      return;
    }
    if (message.type !== 'request' || !Number.isSafeInteger(message.id) || !(message.payload instanceof Uint8Array)) return;
    const id = message.id as number;
    void Promise.resolve()
      .then(() => JSON.parse(Buffer.from(message.payload as Uint8Array).toString('utf8')) as unknown)
      .then(handle)
      .then(
        (result) => ({ schemaVersion: 1, ok: true, result }),
        (error: unknown) => controlFailure(error),
      )
      .then((reply) => worker.postMessage({ type: 'response', id, payload: encodedReply(reply) }))
      .catch(() => worker.postMessage({ type: 'response', id, payload: encodedReply(controlFailure(undefined)) }));
  });
  worker.once('error', (error: unknown) => readyReject?.(error instanceof Error ? error : new Error(String(error))));
  worker.once('exit', (code) => {
    if (!closed && code !== 0) readyReject?.(new Error(`Windows named-pipe worker exited with code ${String(code)}.`));
  });
  try {
    await ready;
  } catch (error) {
    closed = true;
    await worker.terminate();
    throw error;
  }
  return {
    endpoint,
    close: async () => {
      if (closed) return;
      closed = true;
      const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
      worker.postMessage({ type: 'close' });
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, WORKER_CLOSE_MS);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (worker.threadId !== -1) await worker.terminate();
    },
  };
}

export function createWindowsLiveLocalPlatform(): WindowsLiveLocalPlatform {
  return {
    currentUserSid,
    start: startWindowsLiveLocalControlServer,
    request: (endpoint, value) => requestSocketLiveLocalControl(createConnection(endpoint), value),
  };
}
