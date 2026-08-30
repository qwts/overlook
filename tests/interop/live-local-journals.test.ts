import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { queryAll } from '../../src/main/db/sql.js';
import { LiveLocalJournalSessionHandler, type LiveLocalJournalSocket } from '../../src/main/interop/live-local-journal-session.js';
import {
  decodeLiveLocalObjectChunk,
  encodeLiveLocalObjectChunk,
  LiveLocalObjectStore,
} from '../../src/main/interop/live-local-object-store.js';
import { LiveLocalRouteRepository } from '../../src/main/interop/live-local-route-repository.js';
import type { LiveLocalWebSocketFrame } from '../../src/main/interop/live-local-session.js';
import { SyncProtocolService } from '../../src/main/interop/sync-protocol.js';
import { SyncRepository } from '../../src/main/interop/sync-repository.js';

const PAIRING_ID = '56d15daa-4f24-466c-b20d-69b78e8320f6';
const OPERATION_ID = '48ced8d7-2f3a-4b60-967f-8f1c27867e65';
const REMOTE_SESSION_ID = '6af6239d-8ce9-4ac8-b9ca-ffb0e55635cf';
const SCOPE_HASH = 'a'.repeat(64);
const PATH = `pairings/${PAIRING_ID}/transfers/${OPERATION_ID}/objects/messages/outbox/value.bin`;

function database() {
  return openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-live-journal-')), 'library.db'),
    dbKey: randomBytes(32),
  });
}

function textFrame(value: unknown): LiveLocalWebSocketFrame {
  return { opcode: 1, payload: Buffer.from(JSON.stringify(value), 'utf8') };
}

test('persists one reviewed route and requires the same remote resume identity', () => {
  const db = database();
  const routes = new LiveLocalRouteRepository(db);
  const input = {
    operationId: OPERATION_ID,
    pairingId: PAIRING_ID,
    operation: 'move' as const,
    remoteSessionId: REMOTE_SESSION_ID,
    scopeHash: SCOPE_HASH,
    at: '2026-08-29T12:00:00.000Z',
  };
  assert.equal(routes.open(input).state, 'connected');
  assert.equal(routes.setState(OPERATION_ID, 'paused', '2026-08-29T12:01:00.000Z').state, 'paused');
  assert.equal(routes.open({ ...input, at: '2026-08-29T12:02:00.000Z' }).state, 'connected');
  assert.throws(() => routes.open({ ...input, remoteSessionId: '07a69c07-6947-4f72-a82d-45505c376cb4' }), /resume did not match/u);
  routes.setState(OPERATION_ID, 'paused', '2026-08-29T12:03:00.000Z');
  assert.throws(() => routes.changeTransport(OPERATION_ID, 'pcloud', 'b'.repeat(64), input.at), /reviewed scope/u);
  assert.equal(routes.changeTransport(OPERATION_ID, 'pcloud', SCOPE_HASH, input.at).transport, 'pcloud');
  assert.throws(() => routes.open({ ...input, at: '2026-08-29T12:04:00.000Z' }), /different reviewed transport/u);
  db.close();
});

test('local object frames stay bounded, verify every chunk, and wait for peer acknowledgement', async () => {
  const sent: Buffer[] = [];
  const store = new LiveLocalObjectStore({ sendBinary: (bytes) => sent.push(Buffer.from(bytes)) });
  const payload = Buffer.alloc(5 * 1024 * 1024, 0x5a);
  const pending = store.put(PATH, payload);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
  assert.ok(sent.every((frame) => frame.length <= 4 * 1024 * 1024));
  const decoded = sent.map(decodeLiveLocalObjectChunk);
  assert.equal(decoded[0]?.header.objectBytes, payload.length);
  assert.throws(() => store.acknowledge(PATH, '0'.repeat(64)), /did not match/u);
  const sha256 = createHash('sha256').update(payload).digest('hex');
  store.acknowledge(PATH, sha256);
  assert.deepEqual(await pending, { bytes: payload.length });

  const receiver = new LiveLocalObjectStore({ sendBinary: () => undefined });
  const [first, second] = sent;
  assert.ok(first);
  assert.ok(second);
  assert.equal(receiver.receive(second), null);
  assert.deepEqual(receiver.receive(first), { path: PATH, sha256 });
  assert.deepEqual(await receiver.get(PATH), payload);
  store.close();
  receiver.close();
});

test('authenticated session commits through the durable route and never persists capability authority', async () => {
  const db = database();
  const routes = new LiveLocalRouteRepository(db);
  const encrypted = Buffer.from('encrypted-object');
  const sha256 = createHash('sha256').update(encrypted).digest('hex');
  const objectFrame = encodeLiveLocalObjectChunk(
    {
      schemaVersion: 1,
      type: 'encrypted-object-chunk',
      path: PATH,
      objectBytes: encrypted.length,
      objectSha256: sha256,
      chunkIndex: 0,
      chunkCount: 1,
      chunkBytes: encrypted.length,
      chunkSha256: sha256,
    },
    encrypted,
  );
  const frames: LiveLocalWebSocketFrame[] = [
    textFrame({
      schemaVersion: 1,
      type: 'open',
      operationId: OPERATION_ID,
      remoteSessionId: REMOTE_SESSION_ID,
      scopeHash: SCOPE_HASH,
    }),
    { opcode: 2, payload: objectFrame },
    textFrame({ schemaVersion: 1, type: 'commit' }),
    { opcode: 8, payload: Buffer.alloc(0) },
  ];
  const sent: unknown[] = [];
  let executed = 0;
  const session: LiveLocalJournalSocket = {
    redemption: {
      schemaVersion: 1,
      type: 'redeem',
      sessionId: 'c8865ad8-8975-4abe-9a1c-bbde10a71efa',
      secret: 'x'.repeat(43),
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
      pairingId: PAIRING_ID,
      operation: 'move',
      protocolVersion: 1,
    },
    read: () => {
      const frame = frames.shift();
      if (frame === undefined) throw new Error('Test peer ran out of frames.');
      return Promise.resolve(frame);
    },
    sendText: (value: unknown) => sent.push(value),
    sendBinary: () => undefined,
    sendPong: () => undefined,
    close: () => undefined,
  };
  const handler = new LiveLocalJournalSessionHandler({
    now: () => '2026-08-29T12:00:00.000Z',
    createOperation: ({ store }) => ({
      routes,
      execute: async () => {
        executed += 1;
        assert.deepEqual(await store.get(PATH), encrypted);
        return { completed: true };
      },
      pause: () => undefined,
      cancel: () => undefined,
    }),
  });
  await handler.handle(session);
  assert.equal(executed, 1);
  assert.equal(routes.get(OPERATION_ID)?.state, 'completed');
  assert.ok(sent.some((value) => typeof value === 'object' && value !== null && 'type' in value && value.type === 'object-ack'));
  const columns = queryAll<{ name: string }>(db, 'PRAGMA table_info(interop_transport_routes)');
  assert.equal(
    columns.some(({ name }) => name.includes('secret') || name.includes('capability')),
    false,
  );
  db.close();
});

test('disconnected Sync journals resume locally without changing reviewed decisions', () => {
  const db = database();
  const repository = new SyncRepository(db);
  const sync = new SyncProtocolService('overlook', repository, { now: () => '2026-08-29T12:00:00.000Z' });
  sync.start({
    sessionId: OPERATION_ID,
    pairingId: PAIRING_ID,
    sourceProduct: 'image-trail',
    targetProduct: 'overlook',
    direction: 'two-way',
    scope: { kind: 'all', localIds: [] },
  });
  assert.equal(sync.disconnect(OPERATION_ID).connected, false);
  const resumed = sync.resume(OPERATION_ID);
  assert.equal(resumed.connected, true);
  assert.equal(resumed.phase, 'reviewing');
  assert.deepEqual(resumed.scope, { kind: 'all', localIds: [] });
  db.close();
});
