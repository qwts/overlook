import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';

import {
  BackupIntegrityScrubber,
  verifyRemoteOriginalCiphertext,
  type BackupIntegrityCursor,
  type BackupIntegrityItem,
} from '../../src/main/backup/integrity-scrubber.js';
import { BackupIntegrityCursorStore } from '../../src/main/backup/integrity-cursor.js';
import { createBackupIntegrityRuntime } from '../../src/main/backup/integrity-runtime.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { createEncryptStream, type EnvelopeKey } from '../../src/main/crypto/envelope.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import type { CustodyAuthority } from '../../src/main/backup/custody-authority-repository.js';
import { CustodyResolutionError } from '../../src/main/backup/custody-handle.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

const HASH_A = 'aa'.repeat(32);
const HASH_B = 'bb'.repeat(32);
const HASH_C = 'cc'.repeat(32);

function remotePath(hash: string): string {
  return `blobs/${hash.slice(0, 2)}/${hash}`;
}

test('bounded scrub repairs local-backed remote damage and resumes from its persisted cursor (#302)', async () => {
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-integrity-remote-')) });
  const local = new Map([
    [HASH_A, Buffer.from('ciphertext-a')],
    [HASH_B, Buffer.from('ciphertext-b')],
    [HASH_C, Buffer.from('ciphertext-c')],
  ]);
  const items: BackupIntegrityItem[] = [HASH_A, HASH_B, HASH_C].map((contentHash, index) => ({
    id: `P${String(index + 1)}`,
    contentHash,
    syncState: 'synced',
  }));
  await provider.put(remotePath(HASH_A), Readable.from([local.get(HASH_A) ?? Buffer.alloc(0)]));
  await provider.put(remotePath(HASH_B), Readable.from([Buffer.from('corrupt remote bytes')]));
  let cursor: BackupIntegrityCursor = { version: 1, afterId: null, completedAt: null };
  const saved: BackupIntegrityCursor[] = [];
  const audits: string[] = [];
  const scrubber = new BackupIntegrityScrubber({
    provider,
    batchSize: 2,
    items: ({ afterId, limit }) => items.filter((item) => afterId === null || item.id > afterId).slice(0, limit),
    hasLocal: (hash) => local.has(hash),
    encryptedStream: (hash) => Readable.from([local.get(hash) ?? Buffer.alloc(0)]),
    verifyRemoteCiphertext: () => Promise.resolve(true),
    markUnrecoverable: () => undefined,
    cursor: {
      load: () => Promise.resolve(cursor),
      save: (next) => {
        cursor = next;
        saved.push(next);
        return Promise.resolve();
      },
    },
    audit: (line) => audits.push(line),
    now: () => new Date('2026-07-15T03:00:00.000Z'),
  });

  assert.deepEqual(await scrubber.scrub(), { checked: 2, repaired: 1, unrecoverable: 0, cycleComplete: false });
  assert.equal(cursor.afterId, 'P2');
  assert.deepEqual(await buffer(await provider.getStream(remotePath(HASH_B))), local.get(HASH_B));

  assert.deepEqual(await scrubber.scrub(), { checked: 1, repaired: 1, unrecoverable: 0, cycleComplete: true });
  assert.deepEqual(cursor, { version: 1, afterId: null, completedAt: '2026-07-15T03:00:00.000Z' });
  assert.deepEqual(await buffer(await provider.getStream(remotePath(HASH_C))), local.get(HASH_C));
  assert.ok(saved.length >= 3, 'progress is saved during the bounded walk');
  assert.ok(audits.some((line) => line.includes(`INTEGRITY-REPAIRED photo=P2 hash=${HASH_B}`)));
  assert.ok(audits.some((line) => line.includes(`INTEGRITY-REPAIRED photo=P3 hash=${HASH_C}`)));
});

test('remote-only missing or corrupt objects become explicit unrecoverable errors (#302)', async () => {
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-integrity-offloaded-')) });
  const items: BackupIntegrityItem[] = [
    { id: 'P1', contentHash: HASH_A, syncState: 'offloaded' },
    { id: 'P2', contentHash: HASH_B, syncState: 'offloaded' },
  ];
  await provider.put(remotePath(HASH_B), Readable.from([Buffer.from('corrupt envelope')]));
  const marked: string[] = [];
  const scrubber = new BackupIntegrityScrubber({
    provider,
    batchSize: 10,
    items: ({ afterId, limit }) => items.filter((item) => afterId === null || item.id > afterId).slice(0, limit),
    hasLocal: () => false,
    encryptedStream: () => {
      throw new Error('remote-only rows have no local stream');
    },
    verifyRemoteCiphertext: (_item, ciphertext) => buffer(ciphertext).then((bytes) => bytes.equals(Buffer.from('valid envelope'))),
    markUnrecoverable: (photoId) => marked.push(photoId),
    cursor: {
      load: () => Promise.resolve({ version: 1, afterId: null, completedAt: null }),
      save: () => Promise.resolve(),
    },
    audit: () => undefined,
    now: () => new Date('2026-07-15T03:00:00.000Z'),
  });

  assert.deepEqual(await scrubber.scrub(), { checked: 2, repaired: 0, unrecoverable: 2, cycleComplete: true });
  assert.deepEqual(marked, ['P1', 'P2']);
});

test('cursor progress survives restart and remains provider-scoped (#302)', async () => {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-integrity-cursor-')), 'library.db'),
    dbKey: randomBytes(32),
  });
  const pcloud = new BackupIntegrityCursorStore(db, 'pcloud');
  await pcloud.save({ version: 1, afterId: 'P1500', completedAt: null });

  assert.deepEqual(await new BackupIntegrityCursorStore(db, 'pcloud').load(), {
    version: 1,
    afterId: 'P1500',
    completedAt: null,
  });
  assert.deepEqual(await new BackupIntegrityCursorStore(db, 'mock').load(), {
    version: 1,
    afterId: null,
    completedAt: null,
  });
  db.close();
});

test('cursor provider scope is resolved for each scrub-time load and save (#302 review)', async () => {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-integrity-dynamic-cursor-')), 'library.db'),
    dbKey: randomBytes(32),
  });
  let providerId = 'mock';
  const cursor = new BackupIntegrityCursorStore(db, () => providerId);
  await cursor.save({ version: 1, afterId: 'P10', completedAt: null });
  providerId = 'pcloud';
  assert.deepEqual(await cursor.load(), { version: 1, afterId: null, completedAt: null });
  await cursor.save({ version: 1, afterId: 'P20', completedAt: null });
  providerId = 'mock';
  assert.deepEqual(await cursor.load(), { version: 1, afterId: 'P10', completedAt: null });
  db.close();
});

test('remote-only verification authenticates the envelope and plaintext content address (#302)', async () => {
  const plaintext = Buffer.from('remote-only original');
  const contentHash = createHash('sha256').update(plaintext).digest('hex');
  const key: EnvelopeKey = { id: 1, key: randomBytes(32) };
  const ciphertext = await buffer(Readable.from([plaintext]).pipe(createEncryptStream(key, { photoId: 'P1' })));
  const item: BackupIntegrityItem = { id: 'P1', contentHash, syncState: 'offloaded' };

  assert.equal(await verifyRemoteOriginalCiphertext(item, Readable.from([ciphertext]), () => key.key), true);
  assert.equal(await verifyRemoteOriginalCiphertext({ ...item, id: 'P2' }, Readable.from([ciphertext]), () => key.key), false);
  assert.equal(await verifyRemoteOriginalCiphertext({ ...item, contentHash: HASH_A }, Readable.from([ciphertext]), () => key.key), false);

  let interruptedOnce = false;
  const interrupted = new Readable({
    read() {
      if (interruptedOnce) return;
      interruptedOnce = true;
      this.push(ciphertext.subarray(0, 8));
      this.destroy(new Error('connection reset during download'));
    },
  });
  await assert.rejects(
    verifyRemoteOriginalCiphertext(item, interrupted, () => key.key),
    /connection reset during download/u,
    'transport failures propagate for retry instead of becoming corruption',
  );
});

test('catalog paging includes only stable synced and offloaded recovery claims (#302)', () => {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-integrity-items-')), 'library.db'),
    dbKey: randomBytes(32),
  });
  const repo = new PhotosRepository(db);
  const ledger = new SyncLedger(db);
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-15T00:00:00.000Z')`);
  for (const [index, id] of ['P1', 'P2', 'P3'].entries()) {
    repo.insert({
      id,
      fileName: `${id}.jpg`,
      fileKind: 'jpeg',
      width: 1,
      height: 1,
      bytes: 1,
      contentHash: String(index + 1).repeat(64),
      camera: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focalLength: null,
      takenAt: null,
      gpsLat: null,
      gpsLon: null,
      place: null,
      importedAt: '2026-07-15T00:00:00.000Z',
      importSource: 'test',
      keyId: 1,
    } satisfies PhotoInsert);
  }
  for (const id of ['P1', 'P2']) {
    ledger.setStatus(id, 'syncing');
    ledger.markBackedUp(id, '2026-07-15T00:00:00.000Z');
  }
  ledger.setStatus('P2', 'offloaded');

  assert.deepEqual(repo.integrityItems({ afterId: null, limit: 1 }), [{ id: 'P1', contentHash: '1'.repeat(64), syncState: 'synced' }]);
  assert.deepEqual(repo.integrityItems({ afterId: 'P1', limit: 10 }), [{ id: 'P2', contentHash: '2'.repeat(64), syncState: 'offloaded' }]);
  db.close();
});

test('runtime composition persists progress and marks missing remote-only rows (#302)', async () => {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-integrity-runtime-')), 'library.db'),
    dbKey: randomBytes(32),
  });
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-integrity-runtime-remote-')) });
  const marked: string[] = [];
  const authority: CustodyAuthority = {
    id: 7,
    providerId: provider.id,
    accountId: 'mock-account',
    accountLabel: 'Mock account',
    remoteRoot: '/Overlook/mock-library/',
    state: 'bound',
    createdAt: '2026-07-15T00:00:00.000Z',
    lastVerifiedAt: null,
  };
  const runtime = createBackupIntegrityRuntime({
    db,
    provider,
    authorities: { offloadedAuthorities: () => [authority] },
    custody: { resolveAuthority: () => Promise.resolve({ authority, provider }) },
    repo: {
      integrityItems: (_page, scope) =>
        scope?.syncState === 'offloaded' ? [{ id: 'P1', contentHash: HASH_A, syncState: 'offloaded' }] : [],
    },
    blobs: {
      hasOriginal: () => false,
      getEncryptedStream: () => {
        throw new Error('remote-only row has no local envelope');
      },
    },
    resolveKey: () => undefined,
    markUnrecoverable: (photoId) => marked.push(photoId),
    audit: () => undefined,
  });

  assert.deepEqual(await runtime.scrub(), { checked: 1, repaired: 0, unrecoverable: 1, cycleComplete: true });
  assert.deepEqual(marked, ['P1']);
  assert.notEqual((await new BackupIntegrityCursorStore(db, provider.id).load()).completedAt, null);
  assert.notEqual((await new BackupIntegrityCursorStore(db, 'custody-authority:7').load()).completedAt, null);
  db.close();
});

test('a custody identity failure neither reads the backup target nor marks the bound row corrupt (#731)', async () => {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-integrity-custody-fail-')), 'library.db'),
    dbKey: randomBytes(32),
  });
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-integrity-wrong-target-')) });
  let reads = 0;
  provider.getStream = () => {
    reads += 1;
    return Promise.reject(new Error('wrong target read'));
  };
  const marked: string[] = [];
  const audits: string[] = [];
  const authority: CustodyAuthority = {
    id: 8,
    providerId: 'other-provider',
    accountId: 'bound-account',
    accountLabel: 'bound@example.test',
    remoteRoot: '/Overlook/bound-library/',
    state: 'bound',
    createdAt: '2026-07-15T00:00:00.000Z',
    lastVerifiedAt: null,
  };
  const runtime = createBackupIntegrityRuntime({
    db,
    provider,
    authorities: { offloadedAuthorities: () => [authority] },
    custody: { resolveAuthority: () => Promise.reject(new CustodyResolutionError('custody-wrong-account')) },
    repo: {
      integrityItems: (_page, scope) =>
        scope?.syncState === 'offloaded' ? [{ id: 'P1', contentHash: HASH_A, syncState: 'offloaded' }] : [],
    },
    blobs: {
      hasOriginal: () => false,
      getEncryptedStream: () => {
        throw new Error('remote-only row has no local envelope');
      },
    },
    resolveKey: () => undefined,
    markUnrecoverable: (photoId) => marked.push(photoId),
    audit: (line) => audits.push(line),
  });

  assert.deepEqual(await runtime.scrub(), { checked: 0, repaired: 0, unrecoverable: 0, cycleComplete: false });
  assert.equal(reads, 0);
  assert.deepEqual(marked, []);
  assert.ok(audits.includes('INTEGRITY-CUSTODY-SKIP authority=8 reason=custody-wrong-account'));
  db.close();
});
