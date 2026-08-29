import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

interface PipeBinding {
  request(endpoint: string, serverSid: string, payload: Buffer, maxFrameBytes: number, timeoutMs: number): Buffer;
}

interface PipeClientWorkerData {
  readonly endpoint: string;
  readonly serverSid: string;
  readonly payload: Uint8Array;
  readonly maxFrameBytes: number;
  readonly timeoutMs: number;
}

function validWorkerData(value: unknown): value is PipeClientWorkerData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Partial<PipeClientWorkerData>;
  return (
    typeof data.endpoint === 'string' &&
    data.endpoint.startsWith('\\\\.\\pipe\\com.qwts.overlook.interop-') &&
    typeof data.serverSid === 'string' &&
    /^S-1-(?:\d+-){1,14}\d+$/u.test(data.serverSid) &&
    data.payload instanceof Uint8Array &&
    typeof data.maxFrameBytes === 'number' &&
    Number.isSafeInteger(data.maxFrameBytes) &&
    data.maxFrameBytes > 0 &&
    data.maxFrameBytes <= 1024 * 1024 &&
    data.payload.length <= data.maxFrameBytes &&
    typeof data.timeoutMs === 'number' &&
    Number.isSafeInteger(data.timeoutMs) &&
    data.timeoutMs > 0 &&
    data.timeoutMs <= 60_000
  );
}

if (parentPort === null || !validWorkerData(workerData)) throw new Error('Invalid Windows named-pipe client configuration.');

const nativeRequire = createRequire(import.meta.url);
const binding = nativeRequire('@overlook/windows-interop/pipe.cjs') as PipeBinding;

try {
  const response = binding.request(
    workerData.endpoint,
    workerData.serverSid,
    Buffer.from(workerData.payload),
    workerData.maxFrameBytes,
    workerData.timeoutMs,
  );
  parentPort.postMessage({ type: 'response', payload: response });
} catch (error) {
  const failure = error as { readonly code?: unknown; readonly message?: unknown } | null;
  parentPort.postMessage({
    type: 'error',
    code: typeof failure?.code === 'string' ? failure.code : 'native-error',
    message: typeof failure?.message === 'string' ? failure.message : 'Windows named-pipe request failed.',
  });
}
