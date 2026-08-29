import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Socket } from 'node:net';

import {
  LIVE_LOCAL_CAPABILITY_TTL_MS,
  LIVE_LOCAL_CONTROL_FRAME_BYTES,
  LiveLocalCapabilityBroker,
  type LiveLocalBootstrapResult,
  type LiveLocalRedemption,
} from './live-local-security.js';

const WEB_SOCKET_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WEB_SOCKET_PROTOCOL = 'overlook.interop.v1';
const SESSION_PATH = /^\/session\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const SESSION_IDLE_MS = 60_000;

export interface LiveLocalWebSocketFrame {
  readonly opcode: number;
  readonly payload: Buffer;
}

class WebSocketReader {
  private pending: Buffer;
  private readonly iterator: AsyncIterator<Buffer>;

  constructor(socket: Socket, initial: Buffer) {
    this.pending = Buffer.from(initial);
    this.iterator = socket[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async exactly(length: number, limit: number): Promise<Buffer> {
    while (this.pending.length < length) {
      const next = await this.iterator.next();
      if (next.done === true) throw new Error('Live local session ended before its frame completed.');
      if (next.value.length > limit - this.pending.length) throw new Error('Live local session exceeded its read bound.');
      this.pending = Buffer.concat([this.pending, next.value], this.pending.length + next.value.length);
    }
    const value = this.pending.subarray(0, length);
    this.pending = this.pending.subarray(length);
    return value;
  }
}

function frameHeader(opcode: number, length: number): Buffer {
  if (length < 126) return Buffer.from([0x80 | opcode, length]);
  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const header = frameHeader(opcode, payload.length);
  return Buffer.concat([header, payload], header.length + payload.length);
}

async function readClientFrame(reader: WebSocketReader, maxPayloadBytes: number): Promise<LiveLocalWebSocketFrame> {
  const maxBufferedBytes = maxPayloadBytes + 14;
  const first = await reader.exactly(2, maxBufferedBytes);
  if (((first[0] as number) & 0x80) === 0) throw new Error('Fragmented live local frames are unsupported.');
  if (((first[1] as number) & 0x80) === 0) throw new Error('Live local client frames must be masked.');
  let length = (first[1] as number) & 0x7f;
  if (length === 126) length = (await reader.exactly(2, maxBufferedBytes)).readUInt16BE();
  else if (length === 127) {
    const wide = (await reader.exactly(8, maxBufferedBytes)).readBigUInt64BE();
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Live local frame length is unsafe.');
    length = Number(wide);
  }
  if (length > maxPayloadBytes) throw new Error('Live local frame exceeded its payload bound.');
  const mask = await reader.exactly(4, maxBufferedBytes);
  const payload = Buffer.from(await reader.exactly(length, maxBufferedBytes));
  for (let index = 0; index < payload.length; index += 1)
    payload[index] = (payload[index] as number) ^ (mask[index % mask.length] as number);
  return { opcode: (first[0] as number) & 0x0f, payload };
}

function acceptKey(key: string): string {
  return createHash('sha1').update(`${key}${WEB_SOCKET_MAGIC}`).digest('base64');
}

function validWebSocketKey(value: string | string[] | undefined): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{22}==$/u.test(value)) return false;
  return Buffer.from(value, 'base64').length === 16;
}

function rejectUpgrade(socket: Socket, status: number): void {
  socket.end(`HTTP/1.1 ${String(status)} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function closePayload(code: number): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code);
  return payload;
}

export class LiveLocalAcceptedSession {
  constructor(
    readonly redemption: LiveLocalRedemption,
    private readonly socket: Socket,
    private readonly reader: WebSocketReader,
  ) {}

  read(maxPayloadBytes: number): Promise<LiveLocalWebSocketFrame> {
    return readClientFrame(this.reader, maxPayloadBytes);
  }

  sendText(value: unknown): void {
    this.socket.write(encodeFrame(1, Buffer.from(JSON.stringify(value), 'utf8')));
  }

  sendBinary(value: Buffer): void {
    this.socket.write(encodeFrame(2, value));
  }

  sendPong(value: Buffer): void {
    this.socket.write(encodeFrame(10, value));
  }

  close(code = 1000): void {
    if (!this.socket.destroyed) this.socket.end(encodeFrame(8, closePayload(code)));
  }
}

export interface LiveLocalSessionListenerOptions {
  readonly expectedExtensionId: string;
  readonly onSession: (session: LiveLocalAcceptedSession) => Promise<void> | void;
}

export class LiveLocalSessionListener {
  private server: Server | null = null;
  private broker: LiveLocalCapabilityBroker | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly acceptedSockets = new Set<Socket>();
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;

  constructor(private readonly options: LiveLocalSessionListenerOptions) {}

  async issue(value: unknown): Promise<LiveLocalBootstrapResult> {
    await this.ensureListening();
    const broker = this.broker;
    if (broker === null) throw new Error('Live local capability broker did not start.');
    const result = broker.issue('running', value);
    if (result.state === 'running') {
      const sessionId = result.capability.sessionId;
      const timer = setTimeout(() => {
        broker.revoke(sessionId);
        this.expiryTimers.delete(sessionId);
        void this.stopIfIdle();
      }, LIVE_LOCAL_CAPABILITY_TTL_MS);
      timer.unref();
      this.expiryTimers.set(sessionId, timer);
    } else void this.stopIfIdle();
    return result;
  }

  async closeSessions(): Promise<void> {
    await this.stop();
  }

  async close(): Promise<void> {
    await this.stop();
  }

  private async ensureListening(): Promise<void> {
    if (this.stopping !== null) await this.stopping;
    if (this.server !== null) return;
    this.starting ??= this.start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async start(): Promise<void> {
    const server = createServer();
    server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => this.upgrade(request, socket, head));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error('Live local listener did not bind the required loopback address.');
    }
    this.server = server;
    this.broker = new LiveLocalCapabilityBroker({
      expectedExtensionId: this.options.expectedExtensionId,
      endpoint: `ws://127.0.0.1:${String(address.port)}`,
    });
  }

  private upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const broker = this.broker;
    const path = request.url === undefined ? null : SESSION_PATH.exec(request.url);
    const sessionId = path?.[1];
    if (
      broker === null ||
      request.socket.remoteAddress !== '127.0.0.1' ||
      request.headers.origin !== `chrome-extension://${this.options.expectedExtensionId}` ||
      request.headers['sec-websocket-protocol'] !== WEB_SOCKET_PROTOCOL ||
      sessionId === undefined ||
      !broker.has(sessionId)
    ) {
      rejectUpgrade(socket, 403);
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (!validWebSocketKey(key) || request.headers['sec-websocket-version'] !== '13') {
      rejectUpgrade(socket, 400);
      return;
    }
    this.sockets.add(socket);
    socket.setTimeout(SESSION_IDLE_MS, () => socket.destroy());
    socket.once('close', () => {
      this.sockets.delete(socket);
      this.acceptedSockets.delete(socket);
      void this.stopIfIdle();
    });
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\nSec-WebSocket-Protocol: ${WEB_SOCKET_PROTOCOL}\r\n\r\n`,
    );
    void this.acceptSession(socket, head, sessionId, broker);
  }

  private async acceptSession(socket: Socket, head: Buffer, sessionId: string, broker: LiveLocalCapabilityBroker): Promise<void> {
    try {
      const reader = new WebSocketReader(socket, head);
      const first = await readClientFrame(reader, LIVE_LOCAL_CONTROL_FRAME_BYTES);
      if (first.opcode !== 1) throw new Error('Live local redemption must be a text control frame.');
      const redemption = broker.redeem(JSON.parse(first.payload.toString('utf8')) as unknown);
      if (redemption.sessionId !== sessionId) throw new Error('Live local redemption path did not match its session.');
      const expiry = this.expiryTimers.get(sessionId);
      if (expiry !== undefined) clearTimeout(expiry);
      this.expiryTimers.delete(sessionId);
      this.acceptedSockets.add(socket);
      const session = new LiveLocalAcceptedSession(redemption, socket, reader);
      session.sendText({ schemaVersion: 1, ok: true });
      await this.options.onSession(session);
    } catch {
      if (!socket.destroyed) socket.end(encodeFrame(8, closePayload(1008)));
    }
  }

  private async stopIfIdle(): Promise<void> {
    if (this.expiryTimers.size === 0 && this.acceptedSockets.size === 0) await this.stop();
  }

  private async stop(): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    const server = this.server;
    if (server === null) return;
    this.server = null;
    this.broker?.clear();
    this.broker = null;
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.acceptedSockets.clear();
    this.stopping = new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
    try {
      await this.stopping;
    } finally {
      this.stopping = null;
    }
  }
}
