import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { BackupEngine, type BackupEngineDeps } from '../../src/main/backup/backup-engine.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { CustodyAuthorityRepository } from '../../src/main/backup/custody-authority-repository.js';
import { CustodyHandleResolver, custodyRemoteRoot } from '../../src/main/backup/custody-handle.js';
import { CustodyGate, CustodyHintCoordinator } from '../../src/main/backup/custody-gate.js';
import { ProviderRuntime } from '../../src/main/backup/provider-runtime.js';
import { DeterministicICloudDriveBridge } from '../../src/main/backup/icloud-drive/deterministic-bridge.js';
import type { LibraryEntry } from '../../src/shared/library/registry.js';
import { OffloadService, RehydrateError } from '../../src/main/backup/offload.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import { sampleJpeg } from '../../src/main/library/seed.js';
import type { EnvelopeKey } from '../../src/main/crypto/envelope.js';
import type { SafeStorageLike } from '../../src/main/crypto/keystore.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(plainText, 'utf8'),
  decryptString: (encrypted) => encrypted.toString('utf8'),
};

// #107: originals live only in the cloud, safely, and come back when
// needed — over the REAL store/ledger/provider, backed up by the REAL
// engine first (eligibility trusts #106's verified bit).

async function world(count: number, providerConnected = true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-offload-'));
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT OR IGNORE INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-13T00:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  const store = new BlobStore({ dataDir });
  await store.init();
  const key: EnvelopeKey = { id: 1, key: randomBytes(32) };
  const plaintexts = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    const bytes = sampleJpeg(index);
    const ref = await store.putOriginal(Readable.from([bytes]), key, `P${String(index)}`);
    await store.putThumb(Readable.from([bytes]), key, `P${String(index)}`, ref.contentHash, 'thumb');
    plaintexts.set(`P${String(index)}`, bytes);
    repo.insert({
      id: `P${String(index)}`,
      fileName: `IMG_${String(index)}.JPG`,
      fileKind: 'jpeg',
      width: 1,
      height: 1,
      bytes: ref.bytes,
      contentHash: ref.contentHash,
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
      importedAt: `2026-07-13T00:0${String(index % 10)}:00.000Z`,
      importSource: 'test',
      keyId: 1,
    } satisfies PhotoInsert);
  }
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-remote-')) });
  const ledger = new SyncLedger(db);
  const authorities = new CustodyAuthorityRepository(db);
  const remoteRoot = custodyRemoteRoot('01JZZZZZZZZZZZZZZZZZZZZZZZ');
  const custody = new CustodyHandleResolver({
    authorityForPhoto: (photoId) => authorities.forPhoto(photoId),
    provider: (providerId) => (providerId === provider.id ? provider : undefined),
    remoteRoot: () => remoteRoot,
  });
  const custodyHints: NonNullable<LibraryEntry['custodyHints']>[] = [];
  const hintCoordinator = new CustodyHintCoordinator({
    authorities,
    write: (hints) => custodyHints.push(hints),
  });
  const audits: string[] = [];
  const engineDeps: BackupEngineDeps = {
    provider,
    ledger,
    dirtyPhotos: () => repo.dirtyPhotos(),
    encryptedStream: (hash) => store.getEncryptedStream(hash),
    sealManifest: (json) => Promise.resolve(Buffer.from(json)),
    sealRecoveryBootstrap: () => Buffer.from('recovery-bootstrap'),
    libraryId: () => '01JZZZZZZZZZZZZZZZZZZZZZZZ',
    manifestSnapshot: () => repo.manifestSnapshot(),
    settings: () => ({ throttlePercent: null, wifiOnly: false, autoBackupOnImport: false }),
    network: () => 'wifi',
    events: { progress: () => undefined },
    now: () => Date.parse('2026-07-13T03:00:00.000Z'),
    sleep: () => Promise.resolve(),
    pendingCountChanged: () => undefined,
    syncStateChanged: () => undefined,
    audit: (line) => audits.push(line),
    integrityScrub: () => Promise.resolve({ checked: 0, repaired: 0, unrecoverable: 0, cycleComplete: true }),
    recoveryGenerationHealthy: () => Promise.resolve(true),
  };
  const changed: { id: string; syncState: string }[][] = [];
  let storageChanges = 0;
  const service = new OffloadService({
    provider,
    providerConnected: () => providerConnected,
    offloadAuthority: async (bytes) => {
      const identity = await provider.accountIdentity();
      const authority = authorities.create({
        providerId: provider.id,
        accountId: identity.accountId,
        accountLabel: identity.accountLabel,
        remoteRoot,
        createdAt: '2026-07-13T03:00:00.000Z',
      });
      hintCoordinator.beforeBinding({ providerId: authority.providerId, accountId: authority.accountId }, bytes);
      return authority.id;
    },
    custody,
    custodyChanged: () => hintCoordinator.refresh(),
    ledger,
    repo: {
      get: (id) => repo.get(id),
      countByContentHash: (hash) => repo.countByContentHash(hash),
      offloadedIds: () => repo.offloadedPhotoIds(),
    },
    ledgerDirty: (photoId) => ledger.isDirty(photoId),
    blobs: {
      deleteOriginal: async (hash) => store.deleteOriginal(hash),
      hasOriginal: (hash) => store.hasOriginal(hash),
      encryptedStream: (hash) => store.getEncryptedStream(hash),
      restoreOriginal: async (hash, ciphertext, photoId) => store.restoreOriginal(hash, ciphertext, () => key.key, photoId),
    },
    syncStateChanged: (updates) => changed.push([...updates]),
    storageChanged: () => (storageChanges += 1),
    audit: (line) => audits.push(line),
  });
  return {
    db,
    repo,
    store,
    provider,
    authorities,
    custodyHints,
    ledger,
    key,
    plaintexts,
    audits,
    changed,
    storageChanges: () => storageChanges,
    service,
    engine: new BackupEngine(engineDeps),
  };
}

describe('offload + rehydrate (#107)', () => {
  test('EXIT CRITERIA: verified-synced offloads — original gone, THUMBS STAY, stats shift', async () => {
    const w = await world(2);
    await w.engine.run();
    const photo = w.repo.get('P0');
    assert.notEqual(photo, undefined);
    const deleteOriginal = w.store.deleteOriginal.bind(w.store);
    w.store.deleteOriginal = async (hash) => {
      assert.notEqual(w.authorities.forPhoto('P0'), undefined, 'the binding is durable before local deletion starts');
      await deleteOriginal(hash);
    };

    const summary = await w.service.offload(['P0']);
    assert.deepEqual({ offloaded: summary.offloaded, skipped: summary.skipped }, { offloaded: 1, skipped: 0 });
    assert.equal(summary.failed, 0);
    assert.deepEqual(summary.results, [{ photoId: 'P0', outcome: 'offloaded', reason: null }]);
    assert.equal(summary.freedBytes, photo?.bytes);
    assert.equal(w.ledger.status('P0'), 'offloaded');
    assert.equal(w.authorities.forPhoto('P0')?.accountId, 'mock-account', 'sole-remote state records the verified account');
    assert.deepEqual(w.custodyHints.at(-1), [
      { providerId: 'mock', accountId: 'mock-account', soleCustodyItems: 1, soleCustodyBytes: photo?.bytes },
    ]);
    assert.equal(w.store.hasOriginal(photo?.contentHash ?? ''), false, 'original evicted');
    // Thumbs stay: the grid keeps browsing offline (ADR-0007).
    const thumb = await buffer(w.store.getThumbStream(photo?.contentHash ?? '', 'thumb', () => w.key.key, 'P0'));
    assert.deepEqual(thumb, w.plaintexts.get('P0'));
    assert.equal(w.repo.stats().offloadedBytes, photo?.bytes, 'the sidebar split sees it');
    assert.deepEqual(w.changed, [[{ id: 'P0', syncState: 'offloaded' }]], 'tiles get their targeted push');
    assert.equal(w.storageChanges(), 1, 'aggregate storage/count consumers refresh once per batch');
  });

  test('ineligible rows are skipped, never forced: dirty, unsynced, unknown', async () => {
    const w = await world(2);
    await w.engine.run();
    w.ledger.markDirty('P0'); // synced but dirty again — not eligible
    const summary = await w.service.offload(['P0', 'GHOST']);
    assert.deepEqual({ offloaded: summary.offloaded, skipped: summary.skipped }, { offloaded: 0, skipped: 2 });
    assert.deepEqual(summary.results, [
      { photoId: 'P0', outcome: 'skipped', reason: 'dirty' },
      { photoId: 'GHOST', outcome: 'skipped', reason: 'missing-photo' },
    ]);
    assert.equal(w.store.hasOriginal(w.repo.get('P0')?.contentHash ?? ''), true);
  });

  test('preflight is read-only and reports exact eligible, skip reasons, and estimated bytes (#281)', async () => {
    const w = await world(3);
    await w.engine.run();
    w.ledger.markDirty('P1');
    w.ledger.setStatus('P2', 'offloaded');

    const plan = await w.service.preflight(['P0', 'P1', 'P2', 'GHOST', 'P0']);
    assert.deepEqual(plan, {
      eligible: 1,
      ineligible: 3,
      estimatedFreedBytes: w.repo.get('P0')?.bytes,
      items: [
        { photoId: 'P0', bytes: w.repo.get('P0')?.bytes, eligible: true, reason: null },
        { photoId: 'P1', bytes: w.repo.get('P1')?.bytes, eligible: false, reason: 'dirty' },
        { photoId: 'P2', bytes: w.repo.get('P2')?.bytes, eligible: false, reason: 'already-offloaded' },
        { photoId: 'GHOST', bytes: 0, eligible: false, reason: 'missing-photo' },
      ],
    });
    assert.equal(w.ledger.status('P0'), 'synced');
    assert.equal(w.store.hasOriginal(w.repo.get('P0')?.contentHash ?? ''), true);
  });

  test('disconnected provider blocks eviction with an explicit reason (#281)', async () => {
    const w = await world(1, false);
    await w.engine.run();
    const plan = await w.service.preflight(['P0']);
    assert.deepEqual(plan.items, [{ photoId: 'P0', bytes: w.repo.get('P0')?.bytes, eligible: false, reason: 'provider-disconnected' }]);
    const result = await w.service.offload(['P0']);
    assert.equal(result.offloaded, 0);
    assert.equal(result.skipped, 1);
    assert.equal(w.store.hasOriginal(w.repo.get('P0')?.contentHash ?? ''), true);
  });

  test('expired and offline providers block eviction with actionable reasons (#281)', async () => {
    const expired = await world(1);
    await expired.engine.run();
    expired.provider.authState = () => Promise.resolve('expired');
    assert.equal((await expired.service.preflight(['P0'])).items[0]?.reason, 'provider-expired');
    assert.equal((await expired.service.offload(['P0'])).results[0]?.reason, 'provider-expired');
    assert.equal(expired.store.hasOriginal(expired.repo.get('P0')?.contentHash ?? ''), true);

    const offline = await world(1);
    await offline.engine.run();
    offline.provider.authState = () => Promise.reject(new Error('offline'));
    assert.equal((await offline.service.preflight(['P0'])).items[0]?.reason, 'provider-offline');
    assert.equal((await offline.service.offload(['P0'])).results[0]?.reason, 'provider-offline');
    assert.equal(offline.store.hasOriginal(offline.repo.get('P0')?.contentHash ?? ''), true);
  });

  test('execution rechecks provider state after preflight before deleting bytes (#281)', async () => {
    const w = await world(1);
    await w.engine.run();
    assert.equal((await w.service.preflight(['P0'])).eligible, 1);
    w.provider.authState = () => Promise.resolve('expired');

    const result = await w.service.offload(['P0']);
    assert.deepEqual(result.results, [{ photoId: 'P0', outcome: 'skipped', reason: 'provider-expired' }]);
    assert.equal(w.store.hasOriginal(w.repo.get('P0')?.contentHash ?? ''), true);
    assert.equal(w.ledger.status('P0'), 'synced');
  });

  test('active-provider remote loss or mismatch blocks eviction despite a synced ledger (#281 review)', async () => {
    const missing = await world(1);
    await missing.engine.run();
    const missingPhoto = missing.repo.get('P0');
    const missingPath = `blobs/${missingPhoto?.contentHash.slice(0, 2) ?? ''}/${missingPhoto?.contentHash ?? ''}`;
    await missing.provider.delete(missingPath);
    assert.equal((await missing.service.preflight(['P0'])).items[0]?.reason, 'remote-missing');
    assert.equal((await missing.service.offload(['P0'])).results[0]?.reason, 'remote-missing');
    assert.equal(missing.store.hasOriginal(missingPhoto?.contentHash ?? ''), true);

    const mismatch = await world(1);
    await mismatch.engine.run();
    const mismatchPhoto = mismatch.repo.get('P0');
    const mismatchPath = `blobs/${mismatchPhoto?.contentHash.slice(0, 2) ?? ''}/${mismatchPhoto?.contentHash ?? ''}`;
    await mismatch.provider.put(mismatchPath, Readable.from([Buffer.from('wrong active-provider object')]));
    assert.equal((await mismatch.service.preflight(['P0'])).items[0]?.reason, 'remote-mismatch');
    assert.equal((await mismatch.service.offload(['P0'])).results[0]?.reason, 'remote-mismatch');
    assert.equal(mismatch.store.hasOriginal(mismatchPhoto?.contentHash ?? ''), true);
  });

  test('a partial delete failure preserves that source and reports exact mixed results (#281)', async () => {
    const w = await world(2);
    await w.engine.run();
    const deleteOriginal = w.store.deleteOriginal.bind(w.store);
    const failedHash = w.repo.get('P0')?.contentHash;
    w.store.deleteOriginal = (hash) => (hash === failedHash ? Promise.reject(new Error('disk busy')) : deleteOriginal(hash));

    const result = await w.service.offload(['P0', 'P1']);
    assert.deepEqual(result.results, [
      { photoId: 'P0', outcome: 'failed', reason: 'delete-failed' },
      { photoId: 'P1', outcome: 'offloaded', reason: null },
    ]);
    assert.equal(w.store.hasOriginal(failedHash ?? ''), true);
    assert.equal(w.ledger.status('P0'), 'synced');
    assert.equal(w.authorities.forPhoto('P0'), undefined, 'a failed eviction rolls back its pending custody binding');
    assert.equal(w.ledger.status('P1'), 'offloaded');
    assert.deepEqual(w.custodyHints.at(-1), [
      {
        providerId: 'mock',
        accountId: 'mock-account',
        soleCustodyItems: 1,
        soleCustodyBytes: w.repo.get('P1')?.bytes,
      },
    ]);
  });

  test('EXIT CRITERIA: rehydrate restores byte-identical, verifies, and flips synced', async () => {
    const w = await world(1);
    await w.engine.run();
    await w.service.offload(['P0']);
    const photo = w.repo.get('P0');
    assert.equal(w.store.hasOriginal(photo?.contentHash ?? ''), false);

    await w.service.rehydrate('P0');
    assert.equal(w.ledger.status('P0'), 'synced');
    const restored = await buffer(w.store.getStream(photo?.contentHash ?? '', () => w.key.key, 'P0'));
    assert.deepEqual(restored, w.plaintexts.get('P0'), 'plaintext round-trips through the cloud');
    assert.deepEqual(w.custodyHints.at(-1), [], 'verified local recovery clears the sealed-library stake');
    assert.ok(w.audits.some((line) => line.startsWith('REHYDRATE-OK photo=P0')));
    assert.deepEqual(w.changed.at(-1), [{ id: 'P0', syncState: 'synced' }]);
    assert.equal(w.storageChanges(), 2, 'standalone rehydrate refreshes immediately after offload');
  });

  test('a real offload blocks disconnect until verified local restoration reaches zero (#732)', async () => {
    const w = await world(1);
    await w.engine.run();
    assert.equal((await w.service.offload(['P0'])).offloaded, 1);
    const activeLibrary = { id: '01JZZZZZZZZZZZZZZZZZZZZZZZ', name: 'Active' };
    const gate = new CustodyGate({ authorities: w.authorities, activeLibrary: () => activeLibrary, libraries: () => [] });
    let providerId: string | null = 'mock';
    const dataDir = mkdtempSync(join(tmpdir(), 'overlook-provider-gate-'));
    const runtime = new ProviderRuntime({
      dataDir: () => dataDir,
      safeStorage: () => fakeSafeStorage,
      openExternal: () => Promise.resolve(),
      setProviderId: (id) => {
        providerId = id;
      },
      providerId: () => providerId,
      isPackaged: false,
      harnessEnv: (name) => (name === 'OVERLOOK_E2E' ? '1' : undefined),
      pcloudEnabled: false,
      pcloudClientId: () => null,
      iCloudDriveBridge: new DeterministicICloudDriveBridge(),
      custodyPreflight: (credential) => gate.preflight(credential),
    });
    runtime.buildProvider({ mockRootDir: mkdtempSync(join(tmpdir(), 'overlook-runtime-gate-')), fault: undefined });

    const blocked = await runtime.disconnect('mock');
    assert.equal(blocked.code, 'custody-restore-required');
    assert.equal(blocked.custody?.totalItems, 1);
    assert.equal(providerId, 'mock');

    assert.equal((await w.service.restoreOriginals()).restored, 1);
    assert.deepEqual(await runtime.disconnect('mock'), { ok: true, reason: null });
    assert.equal(providerId, null);
  });

  test('provider-required authority refuses a new binding without aborting the batch (#732)', async () => {
    const w = await world(2);
    await w.engine.run();
    assert.equal((await w.service.offload(['P0'])).offloaded, 1);
    const authority = w.authorities.forPhoto('P0');
    assert.ok(authority);
    run(w.db, `UPDATE custody_authorities SET state = 'provider-required' WHERE id = ?`, authority.id);

    assert.deepEqual((await w.service.offload(['P1'])).results, [{ photoId: 'P1', outcome: 'failed', reason: 'remote-unverified' }]);
    assert.equal(w.ledger.status('P1'), 'synced');
    assert.deepEqual(w.custodyHints.at(-1), [
      { providerId: 'mock', accountId: 'mock-account', soleCustodyItems: 1, soleCustodyBytes: w.repo.get('P0')?.bytes },
    ]);
  });

  test('a corrupt download never publishes: record stays cleanly offloaded', async () => {
    const w = await world(1);
    await w.engine.run();
    await w.service.offload(['P0']);
    const photo = w.repo.get('P0');
    // Corrupt the remote copy — the restore must verify and refuse.
    await w.provider.put(
      `blobs/${photo?.contentHash.slice(0, 2) ?? ''}/${photo?.contentHash ?? ''}`,
      Readable.from([Buffer.from('garbage')]),
    );

    await assert.rejects(w.service.rehydrate('P0'), RehydrateError);
    assert.equal(w.ledger.status('P0'), 'offloaded', 'status untouched');
    assert.equal(w.store.hasOriginal(photo?.contentHash ?? ''), false, 'no half-restored blob');
    assert.ok(w.audits.some((line) => line.startsWith('REHYDRATE-FAIL photo=P0')));
  });

  test('rehydrating a non-offloaded photo is a typed error', async () => {
    const w = await world(1);
    await assert.rejects(
      w.service.rehydrate('P0'),
      (error: unknown) => error instanceof RehydrateError && error.reason === 'not-offloaded',
    );
  });

  test('batch restore isolates failures and restore-all discovers live offloaded rows (#281)', async () => {
    const w = await world(3);
    await w.engine.run();
    await w.service.offload(['P0', 'P1', 'P2']);
    const p2 = w.repo.get('P2');
    await w.provider.delete(`blobs/${p2?.contentHash.slice(0, 2) ?? ''}/${p2?.contentHash ?? ''}`);

    const summary = await w.service.restoreOriginals();
    assert.deepEqual(summary, {
      restored: 2,
      skipped: 0,
      failed: 1,
      results: [
        { photoId: 'P0', outcome: 'restored', reason: null },
        { photoId: 'P1', outcome: 'restored', reason: null },
        { photoId: 'P2', outcome: 'failed', reason: 'download-failed' },
      ],
    });
    assert.equal(w.ledger.status('P0'), 'synced');
    assert.equal(w.ledger.status('P1'), 'synced');
    assert.equal(w.ledger.status('P2'), 'offloaded');
    assert.deepEqual(w.changed, [
      [
        { id: 'P0', syncState: 'offloaded' },
        { id: 'P1', syncState: 'offloaded' },
        { id: 'P2', syncState: 'offloaded' },
      ],
      [
        { id: 'P0', syncState: 'synced' },
        { id: 'P1', syncState: 'synced' },
      ],
    ]);
    assert.equal(w.storageChanges(), 2, 'offload and restore each emit one aggregate refresh');
  });

  test('batch restore reports disconnected provider and never flips status (#281)', async () => {
    const w = await world(1);
    await w.engine.run();
    await w.service.offload(['P0']);
    w.provider.setConnected(false);
    const summary = await w.service.restoreOriginals(['P0']);
    assert.deepEqual(summary.results, [{ photoId: 'P0', outcome: 'failed', reason: 'custody-disconnected' }]);
    assert.equal(w.ledger.status('P0'), 'offloaded');
  });

  test('a different account receives no restore read for a bound row (#731)', async () => {
    const w = await world(1);
    await w.engine.run();
    await w.service.offload(['P0']);
    let reads = 0;
    const getStream = w.provider.getStream.bind(w.provider);
    w.provider.getStream = (path) => {
      reads += 1;
      return getStream(path);
    };
    w.provider.setAccountIdentity({ accountId: 'different-account', accountLabel: 'other@example.test' });

    assert.deepEqual((await w.service.restoreOriginals(['P0'])).results, [
      { photoId: 'P0', outcome: 'failed', reason: 'custody-wrong-account' },
    ]);
    assert.equal(reads, 0);
    assert.equal(w.ledger.status('P0'), 'offloaded');
  });

  test('batch restore keeps remote-only rows offloaded for expired and offline providers (#281)', async () => {
    const expired = await world(1);
    await expired.engine.run();
    await expired.service.offload(['P0']);
    expired.provider.authState = () => Promise.resolve('expired');
    assert.deepEqual((await expired.service.restoreOriginals(['P0'])).results, [
      { photoId: 'P0', outcome: 'failed', reason: 'custody-unavailable' },
    ]);
    assert.equal(expired.ledger.status('P0'), 'offloaded');

    const offline = await world(1);
    await offline.engine.run();
    await offline.service.offload(['P0']);
    offline.provider.authState = () => Promise.reject(new Error('offline'));
    assert.deepEqual((await offline.service.restoreOriginals(['P0'])).results, [
      { photoId: 'P0', outcome: 'failed', reason: 'custody-unavailable' },
    ]);
    assert.equal(offline.ledger.status('P0'), 'offloaded');
  });
});
