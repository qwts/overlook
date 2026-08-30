import { createHash } from 'node:crypto';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import {
  LIVE_LOCAL_CONTROL_FRAME_BYTES,
  LiveLocalError,
  classifyControlEndpointFailure,
  prepareUnixControlEndpoint,
} from './live-local-security.js';

const CONTROL_HEADER_BYTES = 4;
const CONTROL_DEADLINE_MS = 5_000;
const UNIX_SOCKET_PATH_BYTES = 103;
const UNIX_SOCKET_NAME = 'com.qwts.overlook.interop.sock';
const SHORT_RUNTIME_ROOT = '/tmp';

class BoundedSocketReader {
  private pending = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Buffer>;

  constructor(socket: Socket) {
    this.iterator = socket[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async exactly(length: number): Promise<Buffer> {
    while (this.pending.length < length) {
      const next = await this.iterator.next();
      if (next.done === true) throw new LiveLocalError('Live local control frame ended early.', 'corrupt');
      if (next.value.length > LIVE_LOCAL_CONTROL_FRAME_BYTES + CONTROL_HEADER_BYTES - this.pending.length)
        throw new LiveLocalError('Live local control frame exceeds its bound.', 'over-budget');
      this.pending = Buffer.concat([this.pending, next.value], this.pending.length + next.value.length);
    }
    const value = this.pending.subarray(0, length);
    this.pending = this.pending.subarray(length);
    return value;
  }
}

function encodeControlFrame(value: unknown): Buffer {
  let payload: Buffer;
  try {
    payload = Buffer.from(JSON.stringify(value), 'utf8');
  } catch {
    throw new LiveLocalError('Live local control response is not JSON.', 'corrupt');
  }
  if (payload.length > LIVE_LOCAL_CONTROL_FRAME_BYTES)
    throw new LiveLocalError('Live local control response exceeds its bound.', 'over-budget');
  const header = Buffer.alloc(CONTROL_HEADER_BYTES);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload], CONTROL_HEADER_BYTES + payload.length);
}

function controlFailure(error: LiveLocalError): Record<string, unknown> {
  const code = error.code === 'corrupt' || error.code === 'over-budget' ? 'corrupt' : 'unsupported';
  return { schemaVersion: 1, ok: false, code, retryable: false };
}

async function readControlFrame(socket: Socket): Promise<unknown> {
  const reader = new BoundedSocketReader(socket);
  const length = (await reader.exactly(CONTROL_HEADER_BYTES)).readUInt32LE();
  if (length > LIVE_LOCAL_CONTROL_FRAME_BYTES) throw new LiveLocalError('Live local control frame exceeds its bound.', 'over-budget');
  try {
    return JSON.parse((await reader.exactly(length)).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof LiveLocalError) throw error;
    throw new LiveLocalError('Live local control frame is not JSON.', 'corrupt');
  }
}

function withSocketDeadline<T>(socket: Socket, operation: Promise<T>, timeoutMs = CONTROL_DEADLINE_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new LiveLocalError('Live local control endpoint timed out.', 'unsupported'));
    }, timeoutMs);
    void operation.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

export function liveLocalRuntimeDirectory(profileDirectory: string, temporaryDirectory: string, uid = process.getuid?.()): string {
  if (uid === undefined) throw new LiveLocalError('Live local Unix identity is unavailable.', 'unsupported');
  const suffix = createHash('sha256')
    .update(`${String(uid)}\0${profileDirectory}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  const directoryName = `overlook-${String(uid)}-${suffix}`;
  const preferred = join(temporaryDirectory, directoryName);
  return Buffer.byteLength(join(preferred, UNIX_SOCKET_NAME), 'utf8') <= UNIX_SOCKET_PATH_BYTES
    ? preferred
    : join(SHORT_RUNTIME_ROOT, directoryName);
}

async function endpointIsLive(endpoint: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(endpoint);
    const finish = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => {
      const state = classifyControlEndpointFailure(error);
      if (state === 'not-running') finish(false);
      else reject(error);
    });
  });
}

async function removeOwnedStaleEndpoint(endpoint: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const uid = process.getuid?.();
  if (!metadata.isSocket() || metadata.isSymbolicLink() || (uid !== undefined && metadata.uid !== uid))
    throw new LiveLocalError('Live local control endpoint is not an owned socket.', 'wrong-authority');
  if (await endpointIsLive(endpoint)) throw new LiveLocalError('A live Overlook control endpoint already exists.', 'wrong-authority');
  await unlink(endpoint);
}

async function removeEndpointAfterClose(endpoint: string): Promise<void> {
  try {
    const metadata = await lstat(endpoint);
    const uid = process.getuid?.();
    if (metadata.isSocket() && !metadata.isSymbolicLink() && (uid === undefined || metadata.uid === uid)) await unlink(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export interface LiveLocalControlServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

export async function startUnixLiveLocalControlServer(
  runtimeDirectory: string,
  handle: (value: unknown) => unknown,
): Promise<LiveLocalControlServer> {
  const endpoint = await prepareUnixControlEndpoint(runtimeDirectory);
  await removeOwnedStaleEndpoint(endpoint);
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    void withSocketDeadline(socket, readControlFrame(socket).then(handle))
      .then((response) => socket.end(encodeControlFrame({ schemaVersion: 1, ok: true, result: response })))
      .catch((error: unknown) => {
        if (error instanceof LiveLocalError && !socket.destroyed) socket.end(encodeControlFrame(controlFailure(error)));
        else socket.destroy();
      });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, resolve);
    });
    await chmod(endpoint, 0o600);
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeEndpointAfterClose(endpoint).catch(() => undefined);
    throw error;
  }
  return {
    endpoint,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening)
        await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
      await removeEndpointAfterClose(endpoint);
    },
  };
}

export async function requestUnixLiveLocalControl(endpoint: string, value: unknown): Promise<unknown> {
  return requestSocketLiveLocalControl(createConnection(endpoint), value);
}

export async function requestSocketLiveLocalControl(socket: Socket, value: unknown): Promise<unknown> {
  try {
    await withSocketDeadline(
      socket,
      new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      }),
    );
    socket.write(encodeControlFrame(value));
    return await withSocketDeadline(socket, readControlFrame(socket));
  } finally {
    socket.destroy();
  }
}
