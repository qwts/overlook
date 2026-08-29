import { createRequire } from 'node:module';
import { setImmediate as pause } from 'node:timers/promises';
import { parentPort, workerData } from 'node:worker_threads';

interface PipeServer {
  read(connectTimeoutMs: number, ioTimeoutMs: number): Buffer | null;
  write(payload: Buffer, ioTimeoutMs: number): void;
  disconnect(): void;
  securityDescriptor(): string;
  close(): void;
}

interface PipeBinding {
  readonly PipeServer: new (endpoint: string, sddl: string, maxFrameBytes: number) => PipeServer;
}

interface PipeWorkerData {
  readonly endpoint: string;
  readonly sddl: string;
  readonly maxFrameBytes: number;
}

interface ParentMessage {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly payload?: unknown;
}

const CONNECT_POLL_MS = 50;
const IO_TIMEOUT_MS = 5_000;
const CORRUPT_REPLY = Buffer.from(JSON.stringify({ schemaVersion: 1, ok: false, code: 'corrupt', retryable: false }), 'utf8');
const UNAVAILABLE_REPLY = Buffer.from(JSON.stringify({ schemaVersion: 1, ok: false, code: 'unsupported', retryable: false }), 'utf8');

function validWorkerData(value: unknown): value is PipeWorkerData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Partial<PipeWorkerData>;
  return (
    typeof data.endpoint === 'string' &&
    data.endpoint.startsWith('\\\\.\\pipe\\com.qwts.overlook.interop-') &&
    typeof data.sddl === 'string' &&
    /^D:P\(A;;GA;;;S-1-(?:\d+-){1,14}\d+\)$/u.test(data.sddl) &&
    typeof data.maxFrameBytes === 'number' &&
    Number.isSafeInteger(data.maxFrameBytes) &&
    data.maxFrameBytes > 0 &&
    data.maxFrameBytes <= 1024 * 1024
  );
}

if (parentPort === null || !validWorkerData(workerData)) throw new Error('Invalid Windows named-pipe worker configuration.');

const nativeRequire = createRequire(import.meta.url);
const binding = nativeRequire('@overlook/windows-interop/pipe.cjs') as PipeBinding;
const server = new binding.PipeServer(workerData.endpoint, workerData.sddl, workerData.maxFrameBytes);
const responses = new Map<number, (payload: Buffer) => void>();
let closing = false;
let nextId = 1;

parentPort.on('message', (message: ParentMessage) => {
  if (message.type === 'close') {
    closing = true;
    for (const resolve of responses.values()) resolve(UNAVAILABLE_REPLY);
    responses.clear();
    return;
  }
  if (message.type !== 'response' || !Number.isSafeInteger(message.id) || !(message.payload instanceof Uint8Array)) return;
  const resolve = responses.get(message.id as number);
  if (resolve === undefined) return;
  responses.delete(message.id as number);
  resolve(Buffer.from(message.payload));
});

function response(id: number): Promise<Buffer> {
  return new Promise((resolve) => responses.set(id, resolve));
}

async function run(): Promise<void> {
  parentPort?.postMessage({ type: 'ready', securityDescriptor: server.securityDescriptor() });
  try {
    while (!closing) {
      let payload: Buffer | null;
      try {
        payload = server.read(CONNECT_POLL_MS, IO_TIMEOUT_MS);
      } catch (error) {
        const code = (error as { readonly code?: unknown } | null)?.code;
        try {
          server.write(code === 'over-budget' ? CORRUPT_REPLY : UNAVAILABLE_REPLY, IO_TIMEOUT_MS);
        } catch {
          server.disconnect();
        }
        await pause();
        continue;
      }
      if (payload === null) {
        await pause();
        continue;
      }
      const id = nextId;
      nextId += 1;
      parentPort?.postMessage({ type: 'request', id, payload });
      server.write(await response(id), IO_TIMEOUT_MS);
      await pause();
    }
  } finally {
    server.close();
  }
}

void run().catch((error: unknown) => {
  parentPort?.postMessage({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
