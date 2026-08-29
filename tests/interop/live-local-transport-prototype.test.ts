import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, stat, symlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createConnection, createServer as createNetServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, test } from 'node:test';

import {
  LIVE_LOCAL_CAPABILITY_TTL_MS,
  LIVE_LOCAL_CIPHERTEXT_FRAME_BYTES,
  LIVE_LOCAL_CONTROL_FRAME_BYTES,
  LIVE_LOCAL_IN_FLIGHT_BYTES,
  LiveLocalBackpressureWindow,
  LiveLocalCapabilityBroker,
  LiveLocalPrototypeError,
  classifyControlEndpointFailure,
  prepareUnixControlEndpoint,
  windowsNamedPipeForUser,
  type LiveLocalCapability,
  type LiveLocalBootstrapResult,
  type LiveLocalBootstrapState,
} from '../../src/main/interop/live-local-security.js';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER_EXTENSION_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const PAIRING_ID = 'f03e92fd-ad4a-41e6-aeaf-a65abde4c853';
const WEB_SOCKET_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

interface WebSocketFrame {
  readonly opcode: number;
  readonly payload: Buffer;
}

interface PrototypeMetrics {
  boundAddress: string;
  receivedBytes: number;
  peakFrameBytes: number;
  cancellationAtMs: number | null;
  failures: string[];
}

class ByteReader {
  private pending: Buffer;
  private readonly iterator: AsyncIterator<Buffer>;

  constructor(socket: Socket, initial: Uint8Array = Buffer.alloc(0)) {
    this.pending = Buffer.from(initial);
    this.iterator = socket[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async until(marker: Buffer, limit: number): Promise<Buffer> {
    while (this.pending.indexOf(marker) < 0) await this.readMore(limit);
    const end = this.pending.indexOf(marker) + marker.length;
    const value = this.pending.subarray(0, end);
    this.pending = this.pending.subarray(end);
    return value;
  }

  async exactly(length: number, limit: number): Promise<Buffer> {
    while (this.pending.length < length) await this.readMore(limit);
    const value = this.pending.subarray(0, length);
    this.pending = this.pending.subarray(length);
    return value;
  }

  private async readMore(limit: number): Promise<void> {
    const next = await this.iterator.next();
    if (next.done === true) throw new Error('Socket ended before the expected frame.');
    if (next.value.length > limit - this.pending.length) throw new Error('Socket frame exceeded its read bound.');
    this.pending = Buffer.concat([this.pending, next.value], this.pending.length + next.value.length);
  }
}

function frameHeader(opcode: number, length: number, masked: boolean): Buffer {
  const maskBit = masked ? 0x80 : 0;
  if (length < 126) return Buffer.from([0x80 | opcode, maskBit | length]);
  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = maskBit | 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = maskBit | 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

function encodeFrame(opcode: number, payload: Buffer, masked: boolean): Buffer {
  const header = frameHeader(opcode, payload.length, masked);
  if (!masked) return Buffer.concat([header, payload], header.length + payload.length);
  const mask = randomBytes(4);
  const protectedPayload = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1)
    protectedPayload[index] = (payload[index] as number) ^ (mask[index % mask.length] as number);
  return Buffer.concat([header, mask, protectedPayload], header.length + mask.length + protectedPayload.length);
}

function encodeControlFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload], header.length + payload.length);
}

async function readControlFrame(reader: ByteReader): Promise<unknown> {
  const length = (await reader.exactly(4, LIVE_LOCAL_CONTROL_FRAME_BYTES + 4)).readUInt32LE();
  if (length > LIVE_LOCAL_CONTROL_FRAME_BYTES) throw new Error('Control endpoint frame exceeded its bound.');
  return JSON.parse((await reader.exactly(length, LIVE_LOCAL_CONTROL_FRAME_BYTES + 4)).toString('utf8')) as unknown;
}

async function requestUnixControl(endpoint: string, value: unknown): Promise<LiveLocalBootstrapResult> {
  const socket = createConnection(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(encodeControlFrame(value));
  const response = (await readControlFrame(new ByteReader(socket))) as LiveLocalBootstrapResult;
  socket.destroy();
  return response;
}

async function readFrame(reader: ByteReader, expectMasked: boolean, maxPayloadBytes: number): Promise<WebSocketFrame> {
  const maxBufferedBytes = Math.max(maxPayloadBytes + 14, LIVE_LOCAL_IN_FLIGHT_BYTES + 14);
  const first = await reader.exactly(2, maxBufferedBytes);
  assert.equal((first[0] as number) & 0x80, 0x80, 'prototype accepts complete frames only');
  const masked = ((first[1] as number) & 0x80) !== 0;
  assert.equal(masked, expectMasked);
  let length = (first[1] as number) & 0x7f;
  if (length === 126) length = (await reader.exactly(2, maxBufferedBytes)).readUInt16BE();
  else if (length === 127) {
    const wide = (await reader.exactly(8, maxBufferedBytes)).readBigUInt64BE();
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame length is unsafe.');
    length = Number(wide);
  }
  if (length > maxPayloadBytes) throw new Error('WebSocket frame exceeded its payload bound.');
  const mask = masked ? await reader.exactly(4, maxBufferedBytes) : null;
  const payload = Buffer.from(await reader.exactly(length, maxBufferedBytes));
  if (mask !== null)
    for (let index = 0; index < payload.length; index += 1)
      payload[index] = (payload[index] as number) ^ (mask[index % mask.length] as number);
  return { opcode: (first[0] as number) & 0x0f, payload };
}

function acceptKey(key: string): string {
  return createHash('sha1').update(`${key}${WEB_SOCKET_MAGIC}`).digest('base64');
}

function bootstrapRequest(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    extensionId: EXTENSION_ID,
    pairingId: PAIRING_ID,
    operation: 'move',
    protocolMin: 1,
    protocolMax: 1,
    ...overrides,
  };
}

function redemption(capability: LiveLocalCapability, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    type: 'redeem',
    sessionId: capability.sessionId,
    secret: capability.secret,
    extensionId: capability.extensionId,
    pairingId: capability.pairingId,
    operation: capability.operation,
    protocolVersion: capability.protocolVersion,
    ...overrides,
  };
}

function runningCapability(broker: LiveLocalCapabilityBroker, request: Record<string, unknown> = bootstrapRequest()): LiveLocalCapability {
  const result = broker.issue('running', request);
  assert.equal(result.state, 'running');
  return result.capability;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  return address.port;
}

function rejectUpgrade(socket: Socket, status: number): void {
  socket.end(`HTTP/1.1 ${String(status)} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

async function serveSession(socket: Socket, head: Buffer, broker: LiveLocalCapabilityBroker, metrics: PrototypeMetrics): Promise<void> {
  const reader = new ByteReader(socket, head);
  try {
    const first = await readFrame(reader, true, LIVE_LOCAL_CONTROL_FRAME_BYTES);
    assert.equal(first.opcode, 1);
    broker.redeem(JSON.parse(first.payload.toString('utf8')) as unknown);
    socket.write(encodeFrame(1, Buffer.from('{"schemaVersion":1,"ok":true}'), false));
    for (;;) {
      const frame = await readFrame(reader, true, LIVE_LOCAL_CIPHERTEXT_FRAME_BYTES);
      if (frame.opcode === 2) {
        metrics.receivedBytes += frame.payload.length;
        metrics.peakFrameBytes = Math.max(metrics.peakFrameBytes, frame.payload.length);
        socket.write(encodeFrame(1, Buffer.from(JSON.stringify({ type: 'ack', bytes: metrics.receivedBytes }), 'utf8'), false));
      } else if (frame.opcode === 1) {
        const control = JSON.parse(frame.payload.toString('utf8')) as { type?: unknown };
        if (control.type !== 'cancel') throw new Error('Unexpected prototype control frame.');
        metrics.cancellationAtMs = performance.now();
        socket.end(encodeFrame(8, Buffer.alloc(0), false));
        return;
      } else if (frame.opcode === 8) {
        socket.end();
        return;
      } else throw new Error('Unexpected prototype WebSocket opcode.');
    }
  } catch (error) {
    metrics.failures.push(error instanceof Error ? error.message : 'unknown');
    socket.end(encodeFrame(8, Buffer.alloc(0), false));
  }
}

async function startPrototype(): Promise<{
  readonly broker: LiveLocalCapabilityBroker;
  readonly port: number;
  readonly metrics: PrototypeMetrics;
  close(): Promise<void>;
}> {
  let broker: LiveLocalCapabilityBroker | null = null;
  const sockets = new Set<Socket>();
  const metrics: PrototypeMetrics = {
    boundAddress: '',
    receivedBytes: 0,
    peakFrameBytes: 0,
    cancellationAtMs: null,
    failures: [],
  };
  const server = createServer();
  server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (
      request.socket.remoteAddress !== '127.0.0.1' ||
      request.headers.origin !== EXTENSION_ORIGIN ||
      request.headers['sec-websocket-protocol'] !== 'overlook.interop.v1' ||
      broker === null
    ) {
      rejectUpgrade(socket, 403);
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      rejectUpgrade(socket, 400);
      return;
    }
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\nSec-WebSocket-Protocol: overlook.interop.v1\r\n\r\n`,
    );
    void serveSession(socket, head, broker, metrics);
  });
  const port = await listen(server);
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  metrics.boundAddress = address.address;
  broker = new LiveLocalCapabilityBroker({
    expectedExtensionId: EXTENSION_ID,
    endpoint: `ws://127.0.0.1:${String(port)}`,
  });
  return {
    broker,
    port,
    metrics,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function connectPrototype(
  port: number,
  path: string,
  origin: string,
): Promise<{ readonly status: number; readonly socket: Socket; readonly reader: ByteReader }> {
  const socket = createConnection({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const key = randomBytes(16).toString('base64');
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: overlook.interop.v1\r\nOrigin: ${origin}\r\n\r\n`,
  );
  const reader = new ByteReader(socket);
  const header = (await reader.until(Buffer.from('\r\n\r\n'), 8192)).toString('utf8');
  const match = /^HTTP\/1\.1 (\d{3})/u.exec(header);
  assert.ok(match);
  return { status: Number(match[1]), socket, reader };
}

describe('ADR-0029 capability prototype (#543)', () => {
  test('distinguishes running states and fails closed on authority, version, expiry, and replay', () => {
    let now = 10_000;
    const broker = new LiveLocalCapabilityBroker({
      expectedExtensionId: EXTENSION_ID,
      endpoint: 'ws://127.0.0.1:49152',
      now: () => now,
    });
    for (const state of ['not-running', 'locked', 'unavailable'] as const)
      assert.deepEqual(broker.issue(state, bootstrapRequest()), { schemaVersion: 1, state });
    assert.equal(broker.issue('running', bootstrapRequest({ protocolMin: 2, protocolMax: 3 })).state, 'incompatible');
    assert.throws(
      () => broker.issue('running', bootstrapRequest({ extensionId: OTHER_EXTENSION_ID })),
      (error: unknown) => error instanceof LiveLocalPrototypeError && error.code === 'wrong-authority',
    );

    const valid = runningCapability(broker);
    now += LIVE_LOCAL_CAPABILITY_TTL_MS - 1;
    assert.equal(broker.redeem(redemption(valid)).sessionId, valid.sessionId);
    assert.throws(
      () => broker.redeem(redemption(valid)),
      (error: unknown) => error instanceof LiveLocalPrototypeError && error.code === 'replay',
    );

    const downgraded = runningCapability(broker);
    assert.throws(
      () => broker.redeem(redemption(downgraded, { protocolVersion: 2 })),
      (error: unknown) => error instanceof LiveLocalPrototypeError && error.code === 'unsupported',
    );
    assert.throws(
      () => broker.redeem(redemption(downgraded)),
      (error: unknown) => error instanceof LiveLocalPrototypeError && error.code === 'replay',
    );

    const expired = runningCapability(broker);
    now += LIVE_LOCAL_CAPABILITY_TTL_MS + 1;
    assert.throws(
      () => broker.redeem(redemption(expired)),
      (error: unknown) => error instanceof LiveLocalPrototypeError && error.code === 'expired',
    );
    assert.throws(
      () => broker.issue('running', bootstrapRequest({ padding: 'x'.repeat(LIVE_LOCAL_CONTROL_FRAME_BYTES) })),
      (error: unknown) => error instanceof LiveLocalPrototypeError && error.code === 'over-budget',
    );
  });

  test('bounds ciphertext frames and blocks producers at the negotiated byte window', async () => {
    const window = new LiveLocalBackpressureWindow(1024, 2048);
    const releases = await Promise.all([window.reserve(1024), window.reserve(1024)]);
    let thirdResolved = false;
    const third = window.reserve(1024).then((release) => {
      thirdResolved = true;
      return release;
    });
    await Promise.resolve();
    assert.equal(thirdResolved, false);
    assert.equal(window.inFlight, 2048);
    releases[0]?.();
    const thirdRelease = await third;
    assert.equal(window.peakInFlight, 2048);
    assert.equal(window.inFlight, 2048);
    releases[1]?.();
    thirdRelease();
    assert.equal(window.inFlight, 0);
    assert.throws(
      () => window.reserve(1025),
      (error: unknown) => error instanceof LiveLocalPrototypeError && error.code === 'over-budget',
    );
  });
});

describe('ADR-0029 corrupt control handling (#543)', () => {
  test('maps malformed control values into the closed failure vocabulary', () => {
    const broker = new LiveLocalCapabilityBroker({
      expectedExtensionId: EXTENSION_ID,
      endpoint: 'ws://127.0.0.1:49152',
    });
    assert.throws(
      () => broker.issue('running', bootstrapRequest({ schemaVersion: 2 })),
      (error: unknown) => error instanceof LiveLocalPrototypeError && error.code === 'corrupt',
    );
    assert.throws(
      () => broker.issue('running', { value: 1n }),
      (error: unknown) => error instanceof LiveLocalPrototypeError && error.code === 'corrupt',
    );
    const circular: { self?: unknown } = {};
    circular.self = circular;
    assert.throws(
      () => broker.issue('running', circular),
      (error: unknown) => error instanceof LiveLocalPrototypeError && error.code === 'corrupt',
    );

    const malformed = runningCapability(broker);
    assert.throws(
      () => broker.redeem(redemption(malformed, { schemaVersion: 2 })),
      (error: unknown) => error instanceof LiveLocalPrototypeError && error.code === 'corrupt',
    );
    assert.throws(
      () => broker.redeem(redemption(malformed)),
      (error: unknown) => error instanceof LiveLocalPrototypeError && error.code === 'replay',
    );
    assert.throws(
      () => broker.redeem({ sessionId: 'not-a-session' }),
      (error: unknown) => error instanceof LiveLocalPrototypeError && error.code === 'corrupt',
    );
  });
});

describe('ADR-0029 user-scoped control seams (#543)', () => {
  test('uses an owned mode-0700 Unix directory and a privacy-safe per-user Windows pipe name', async () => {
    const runtimeDirectory = await mkdtemp('/tmp/ovl-live-local-');
    const endpoint = await prepareUnixControlEndpoint(runtimeDirectory);
    assert.equal(endpoint, join(runtimeDirectory, 'com.qwts.overlook.interop.sock'));
    assert.equal((await stat(runtimeDirectory)).mode & 0o777, 0o700);

    const sid = 'S-1-5-21-123456789-987654321-111111111-1001';
    const pipe = windowsNamedPipeForUser(sid);
    assert.match(pipe.path, /^\\\\\.\\pipe\\com\.qwts\.overlook\.interop-[a-f0-9]{24}$/u);
    assert.equal(pipe.path.includes(sid), false);
    assert.equal(pipe.sddl, `D:P(A;;GA;;;${sid})`);
    assert.throws(() => windowsNamedPipeForUser('Everyone'));

    const target = await mkdtemp('/tmp/ovl-live-local-target-');
    const link = `${target}-link`;
    await symlink(target, link);
    await assert.rejects(
      prepareUnixControlEndpoint(link),
      (error: unknown) => error instanceof LiveLocalPrototypeError && error.code === 'wrong-authority',
    );
  });

  test('uses a real user-scoped Unix rendezvous to distinguish absent, locked, incompatible, and running', async () => {
    const runtimeDirectory = await mkdtemp('/tmp/ovl-live-local-control-');
    const endpoint = await prepareUnixControlEndpoint(runtimeDirectory);
    await assert.rejects(
      requestUnixControl(endpoint, bootstrapRequest()),
      (error: unknown) => classifyControlEndpointFailure(error) === 'not-running',
    );

    let state: LiveLocalBootstrapState = 'locked';
    const broker = new LiveLocalCapabilityBroker({
      expectedExtensionId: EXTENSION_ID,
      endpoint: 'ws://127.0.0.1:49152',
    });
    const server = createNetServer((socket) => {
      void readControlFrame(new ByteReader(socket))
        .then((request) => socket.end(encodeControlFrame(broker.issue(state, request))))
        .catch(() => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, resolve);
    });
    try {
      assert.equal((await requestUnixControl(endpoint, bootstrapRequest())).state, 'locked');
      state = 'running';
      assert.equal((await requestUnixControl(endpoint, bootstrapRequest({ protocolMin: 2, protocolMax: 2 }))).state, 'incompatible');
      assert.equal((await requestUnixControl(endpoint, bootstrapRequest())).state, 'running');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe('ADR-0029 real loopback WebSocket prototype (#543)', () => {
  test('rejects rogue origins, redeems once, streams bounded binary frames with backpressure, and cancels promptly', async () => {
    const prototype = await startPrototype();
    try {
      const rogueCapability = runningCapability(prototype.broker);
      const roguePath = new URL(rogueCapability.endpoint).pathname;
      const rogue = await connectPrototype(prototype.port, roguePath, 'https://example.test');
      assert.equal(rogue.status, 403);
      rogue.socket.destroy();

      const capability = runningCapability(prototype.broker);
      const client = await connectPrototype(prototype.port, new URL(capability.endpoint).pathname, EXTENSION_ORIGIN);
      assert.equal(client.status, 101);
      client.socket.write(encodeFrame(1, Buffer.from(JSON.stringify(redemption(capability))), true));
      const accepted = await readFrame(client.reader, false, LIVE_LOCAL_CONTROL_FRAME_BYTES);
      assert.equal(accepted.opcode, 1, prototype.metrics.failures.join(', '));
      assert.deepEqual(JSON.parse(accepted.payload.toString('utf8')), { schemaVersion: 1, ok: true });

      const frameBytes = 512 * 1024;
      const frameCount = 32;
      const frame = Buffer.alloc(frameBytes, 0xa5);
      const window = new LiveLocalBackpressureWindow(LIVE_LOCAL_CIPHERTEXT_FRAME_BYTES, LIVE_LOCAL_IN_FLIGHT_BYTES);
      const releases: Array<() => void> = [];
      const startedAt = performance.now();
      for (let sent = 0; sent < frameCount; sent += 1) {
        const release = await window.reserve(frame.length);
        releases.push(release);
        client.socket.write(encodeFrame(2, frame, true));
        if (window.inFlight === LIVE_LOCAL_IN_FLIGHT_BYTES) {
          const ack = await readFrame(client.reader, false, LIVE_LOCAL_CONTROL_FRAME_BYTES);
          assert.equal((JSON.parse(ack.payload.toString('utf8')) as { type: string }).type, 'ack');
          releases.shift()?.();
        }
      }
      while (releases.length > 0) {
        const ack = await readFrame(client.reader, false, LIVE_LOCAL_CONTROL_FRAME_BYTES);
        assert.equal((JSON.parse(ack.payload.toString('utf8')) as { type: string }).type, 'ack');
        releases.shift()?.();
      }
      const elapsedMs = performance.now() - startedAt;
      assert.equal(prototype.metrics.boundAddress, '127.0.0.1');
      assert.equal(prototype.metrics.receivedBytes, frameBytes * frameCount);
      assert.equal(prototype.metrics.peakFrameBytes, frameBytes);
      assert.equal(window.peakInFlight, LIVE_LOCAL_IN_FLIGHT_BYTES);
      assert.ok((prototype.metrics.receivedBytes / elapsedMs) * 1000 > 1024 * 1024, 'prototype sustains more than 1 MiB/s');

      const cancelSentAt = performance.now();
      client.socket.write(encodeFrame(1, Buffer.from('{"type":"cancel"}'), true));
      const closed = await readFrame(client.reader, false, 125);
      assert.equal(closed.opcode, 8);
      const cancellationAtMs = prototype.metrics.cancellationAtMs;
      assert.ok(cancellationAtMs !== null);
      assert.ok(cancellationAtMs - cancelSentAt < 250);
      client.socket.destroy();
      assert.deepEqual(prototype.metrics.failures, []);
    } finally {
      await prototype.close();
    }
  });

  test('rejects an oversized bootstrap before reading it as a control value', async () => {
    const prototype = await startPrototype();
    try {
      const capability = runningCapability(prototype.broker);
      const client = await connectPrototype(prototype.port, new URL(capability.endpoint).pathname, EXTENSION_ORIGIN);
      assert.equal(client.status, 101);
      client.socket.write(encodeFrame(1, Buffer.alloc(LIVE_LOCAL_CONTROL_FRAME_BYTES + 1, 0x78), true));
      const closed = await readFrame(client.reader, false, 125);
      assert.equal(closed.opcode, 8);
      assert.match(prototype.metrics.failures.join(', '), /(payload|read) bound/u);
      client.socket.destroy();
    } finally {
      await prototype.close();
    }
  });
});
