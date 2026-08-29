import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';

import { LiveLocalBridge } from '../../src/main/interop/live-local-bridge.js';
import { liveLocalRuntimeDirectory, requestUnixLiveLocalControl } from '../../src/main/interop/live-local-control.js';
import { requestLiveLocalBootstrap } from '../../src/main/interop/live-local-native.js';
import { prepareUnixControlEndpoint, type LiveLocalCapability } from '../../src/main/interop/live-local-security.js';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER_EXTENSION_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const PAIRING_ID = 'f03e92fd-ad4a-41e6-aeaf-a65abde4c853';

class SocketReader {
  private pending = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Buffer>;

  constructor(socket: Socket) {
    this.iterator = socket[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async until(marker: Buffer): Promise<Buffer> {
    while (this.pending.indexOf(marker) < 0) await this.more();
    const end = this.pending.indexOf(marker) + marker.length;
    const value = this.pending.subarray(0, end);
    this.pending = this.pending.subarray(end);
    return value;
  }

  async exactly(length: number): Promise<Buffer> {
    while (this.pending.length < length) await this.more();
    const value = this.pending.subarray(0, length);
    this.pending = this.pending.subarray(length);
    return value;
  }

  private async more(): Promise<void> {
    const next = await this.iterator.next();
    if (next.done === true) throw new Error('Socket ended before the expected value.');
    if (this.pending.length + next.value.length > 128 * 1024) throw new Error('Socket test buffer exceeded its bound.');
    this.pending = Buffer.concat([this.pending, next.value], this.pending.length + next.value.length);
  }
}

function maskedFrame(opcode: number, value: unknown): Buffer {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), 'utf8');
  assert.ok(payload.length <= 0xffff);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const protectedPayload = Buffer.from(payload);
  for (let index = 0; index < protectedPayload.length; index += 1)
    protectedPayload[index] = (protectedPayload[index] as number) ^ (mask[index % mask.length] as number);
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
      : Buffer.from([0x80 | opcode, 0xfe, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, mask, protectedPayload]);
}

async function readServerFrame(reader: SocketReader): Promise<{ readonly opcode: number; readonly value: unknown }> {
  const header = await reader.exactly(2);
  assert.equal((header[1] as number) & 0x80, 0);
  const length = (header[1] as number) & 0x7f;
  assert.ok(length < 126);
  const payload = await reader.exactly(length);
  const opcode = (header[0] as number) & 0x0f;
  return {
    opcode,
    value: payload.length === 0 || opcode === 8 ? null : (JSON.parse(payload.toString('utf8')) as unknown),
  };
}

async function connectWebSocket(
  endpoint: string,
  origin = `chrome-extension://${EXTENSION_ID}`,
): Promise<{ readonly status: number; readonly socket: Socket; readonly reader: SocketReader }> {
  const target = new URL(endpoint);
  const socket = createConnection({ host: target.hostname, port: Number(target.port) });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const reader = new SocketReader(socket);
  socket.write(
    `GET ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: overlook.interop.v1\r\nOrigin: ${origin}\r\n\r\n`,
  );
  const response = (await reader.until(Buffer.from('\r\n\r\n'))).toString('utf8');
  const match = /^HTTP\/1\.1 (\d{3})/u.exec(response);
  assert.ok(match);
  return { status: Number(match[1]), socket, reader };
}

function bootstrapRequest(extensionId = EXTENSION_ID): Record<string, unknown> {
  return {
    schemaVersion: 1,
    extensionId,
    pairingId: PAIRING_ID,
    operation: 'move',
    protocolMin: 1,
    protocolMax: 1,
  };
}

function nativeBootstrapRequest(): Record<string, unknown> {
  return { schemaVersion: 2, operation: 'live-local-bootstrap', request: bootstrapRequest() };
}

function redemption(capability: LiveLocalCapability): Record<string, unknown> {
  return {
    schemaVersion: 1,
    type: 'redeem',
    sessionId: capability.sessionId,
    secret: capability.secret,
    extensionId: capability.extensionId,
    pairingId: capability.pairingId,
    operation: capability.operation,
    protocolVersion: capability.protocolVersion,
  };
}

describe('production live local bootstrap (#544)', () => {
  test('classifies desktop state and redeems one authenticated control session', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'overlook-live-profile-'));
    const temporary = await mkdtemp(join(tmpdir(), 'overlook-live-tmp-'));
    let state: 'locked' | 'running' = 'locked';
    const bridge = new LiveLocalBridge({
      platform: 'darwin',
      profileDirectory: profile,
      temporaryDirectory: temporary,
      expectedExtensionId: EXTENSION_ID,
      bootstrapState: () => state,
    });
    assert.equal(await bridge.start(), true);
    const runtimeDirectory = liveLocalRuntimeDirectory(profile, temporary);
    const endpoint = await prepareUnixControlEndpoint(runtimeDirectory);
    try {
      assert.deepEqual(await requestUnixLiveLocalControl(endpoint, bootstrapRequest()), {
        schemaVersion: 1,
        ok: true,
        result: { schemaVersion: 1, state: 'locked' },
      });
      state = 'running';
      const result = await requestLiveLocalBootstrap(nativeBootstrapRequest(), {
        platform: 'darwin',
        packaged: true,
        profileDirectory: profile,
        temporaryDirectory: temporary,
        expectedExtensionId: EXTENSION_ID,
      });
      assert.equal(result.state, 'running');
      if (result.state !== 'running') return;

      const rogue = await connectWebSocket(result.capability.endpoint, 'https://example.test');
      assert.equal(rogue.status, 403);
      rogue.socket.destroy();

      const client = await connectWebSocket(result.capability.endpoint);
      assert.equal(client.status, 101);
      client.socket.write(maskedFrame(1, redemption(result.capability)));
      assert.deepEqual(await readServerFrame(client.reader), { opcode: 1, value: { schemaVersion: 1, ok: true } });
      client.socket.write(maskedFrame(1, { schemaVersion: 1, type: 'heartbeat' }));
      assert.deepEqual(await readServerFrame(client.reader), {
        opcode: 1,
        value: { schemaVersion: 1, type: 'heartbeat-ack' },
      });
      client.socket.write(maskedFrame(1, { schemaVersion: 1, type: 'cancel' }));
      assert.equal((await readServerFrame(client.reader)).opcode, 8);
      client.socket.destroy();

      await bridge.lock();
      assert.deepEqual(await requestUnixLiveLocalControl(endpoint, bootstrapRequest()), {
        schemaVersion: 1,
        ok: true,
        result: { schemaVersion: 1, state: 'locked' },
      });
      assert.deepEqual(await requestUnixLiveLocalControl(endpoint, bootstrapRequest(OTHER_EXTENSION_ID)), {
        schemaVersion: 1,
        ok: false,
        code: 'unsupported',
        retryable: false,
      });
    } finally {
      await bridge.close();
    }
    await assert.rejects(stat(endpoint), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
  });

  test('refuses foreign endpoint files, a second live peer, and unsupported platforms', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'overlook-live-profile-'));
    const temporary = await mkdtemp(join(tmpdir(), 'overlook-live-tmp-'));
    const runtimeDirectory = liveLocalRuntimeDirectory(profile, temporary);
    const endpoint = await prepareUnixControlEndpoint(runtimeDirectory);
    await writeFile(endpoint, 'not a socket');
    const blocked = new LiveLocalBridge({
      platform: 'darwin',
      profileDirectory: profile,
      temporaryDirectory: temporary,
      expectedExtensionId: EXTENSION_ID,
      bootstrapState: () => 'locked',
    });
    await assert.rejects(blocked.start(), /not an owned socket/u);

    const otherProfile = await mkdtemp(join(tmpdir(), 'overlook-live-profile-'));
    const first = new LiveLocalBridge({
      platform: 'darwin',
      profileDirectory: otherProfile,
      temporaryDirectory: temporary,
      expectedExtensionId: EXTENSION_ID,
      bootstrapState: () => 'locked',
    });
    const second = new LiveLocalBridge({
      platform: 'darwin',
      profileDirectory: otherProfile,
      temporaryDirectory: temporary,
      expectedExtensionId: EXTENSION_ID,
      bootstrapState: () => 'locked',
    });
    try {
      await first.start();
      await assert.rejects(second.start(), /already exists/u);
    } finally {
      await first.close();
    }
    const unsupported = new LiveLocalBridge({
      platform: 'linux',
      profileDirectory: otherProfile,
      temporaryDirectory: temporary,
      expectedExtensionId: EXTENSION_ID,
      bootstrapState: () => 'running',
    });
    assert.equal(await unsupported.start(), false);
    await unsupported.close();
  });
});
