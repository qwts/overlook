import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { createActiveProvider } from '../../src/main/backup/active-provider.js';
import { BackupEngine, type BackupEngineDeps } from '../../src/main/backup/backup-engine.js';
import { createManifestDebtStore } from '../../src/main/backup/manifest-debt.js';
import { MockProvider, ProviderRegistry } from '../../src/main/backup/mock-provider.js';
import type { StorageProvider } from '../../src/main/backup/provider.js';
import { guardProviderSwitch, type ProviderSwitchGuardDeps } from '../../src/main/backup/provider-switch-guard.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { claimsForContentHashes, remoteClaims } from '../../src/main/db/backup-claims.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import type { ProtectedRemoteObject } from '../../src/main/db/protected-recovery-repository.js';
import { run } from '../../src/main/db/sql.js';
import { sampleJpeg } from '../../src/main/library/seed.js';
import type { EnvelopeKey } from '../../src/main/crypto/envelope.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #741 regression coverage: a provider switch must never let another
// provider's synced/offloaded claims publish an incomplete manifest on the
// newly selected provider, and switching back to the provider that actually
// holds remote-only objects must stay possible.

/** A MockProvider under a distinct provider id, so the engine's per-provider
 * presence cache and the settings routing behave as with real adapters. */
function providerWithId(id: string, inner: StorageProvider): StorageProvider {
  return {
    id,
    label: id,
    capabilities: inner.capabilities,
    listLibraries: (signal) => inner.listLibraries(signal),
    forLibrary: (libraryId) => providerWithId(id, inner.forLibrary(libraryId)),
    authState: () => inner.authState(),
    accountIdentity: (signal) => inner.accountIdentity(signal),
    put: (path, bytes) => inner.put(path, bytes),
    getStream: (path) => inner.getStream(path),
    probe: (path, signal) => inner.probe(path, signal),
    list: (prefix, signal) => inner.list(prefix, signal),
    delete: (path) => inner.delete(path),
    quota: (signal) => inner.quota(signal),
    verify: (path) => inner.verify(path),
  };
}

async function world(count: number) {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-switch-'));
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT OR IGNORE INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-22T00:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  const store = new BlobStore({ dataDir });
  await store.init();
  const key: EnvelopeKey = { id: 1, key: randomBytes(32) };
  for (let index = 0; index < count; index += 1) {
    const bytes = sampleJpeg(index);
    const ref = await store.putOriginal(Readable.from([bytes]), key, `P${String(index)}`);
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
      importedAt: `2026-07-22T00:0${String(index % 10)}:00.000Z`,
      importSource: 'test',
      keyId: 1,
    } satisfies PhotoInsert);
  }
  const remoteA = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-remote-a-')) });
  const remoteB = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-remote-b-')) });
  const providerA = providerWithId('prov-a', remoteA);
  const providerB = providerWithId('prov-b', remoteB);
  const registry = new ProviderRegistry();
  registry.register(providerA);
  registry.register(providerB);
  // Backup operations route EXCLUSIVELY through the settings selection —
  // the same active-provider facade production uses (#256).
  const settings = { providerId: 'prov-a' };
  const active = createActiveProvider({ registry, activeId: () => settings.providerId, defaultId: () => 'prov-a' });
  const ledger = new SyncLedger(db);
  const audits: string[] = [];
  const deps: BackupEngineDeps = {
    provider: active,
    ledger,
    dirtyPhotos: () => repo.dirtyPhotos(),
    encryptedStream: (hash) => store.getEncryptedStream(hash),
    sealManifest: (json) => Promise.resolve(Buffer.from(json)),
    sealRecoveryBootstrap: () => Buffer.from('recovery-bootstrap'),
    libraryId: () => '01KY000QE5PMZR2P66DX0CCR6D',
    manifestSnapshot: () => repo.manifestSnapshot(),
    settings: () => ({ throttlePercent: null, wifiOnly: false, autoBackupOnImport: false }),
    network: () => 'wifi',
    events: { progress: () => undefined },
    now: () => Date.now(),
    sleep: () => Promise.resolve(),
    pendingCountChanged: () => undefined,
    syncStateChanged: () => undefined,
    audit: (line) => audits.push(line),
    integrityScrub: () => Promise.resolve({ checked: 0, repaired: 0, unrecoverable: 0, cycleComplete: true }),
    recoveryGenerationHealthy: () => Promise.resolve(true),
    claimsForContentHashes: (hashes) => claimsForContentHashes(db, hashes),
    hasLocalOriginal: (hash) => store.hasOriginal(hash),
    manifestDebt: createManifestDebtStore(db),
  };
  return { db, deps, repo, store, ledger, settings, providerA, providerB, audits, engine: new BackupEngine(deps) };
}

describe('provider switching never publishes incomplete manifests (#741)', () => {
  test('pCloud → empty target with synced LOCAL originals: one run re-uploads everything and publishes a complete generation', async () => {
    const w = await world(3);
    await w.engine.run();
    assert.equal((await w.providerA.list('blobs')).length, 3);
    assert.equal((await w.providerA.list('manifest')).length, 1);

    // The switch (guard-approved: nothing remote-only) owes the target a
    // generation; the run's preflight discovers the empty namespace.
    w.settings.providerId = 'prov-b';
    w.engine.oweManifest();
    const result = await w.engine.run();
    assert.equal(result.manifestUploaded, true);
    assert.equal(result.blockedRemoteOnly, 0);
    assert.equal(result.uploaded, 3, 'local originals re-uploaded to the target');
    assert.equal((await w.providerB.list('blobs')).length, 3);
    assert.deepEqual(
      (await w.providerB.list('manifest')).map((entry) => entry.path),
      ['manifest/gen-1.ovlk'],
    );
    // The previous provider's namespace is untouched.
    assert.equal((await w.providerA.list('blobs')).length, 3);
    assert.equal((await w.providerA.list('manifest')).length, 1);
  });

  test('pCloud → empty target with OFFLOADED originals: fails closed, publishes nothing, prunes nothing, flips nothing', async () => {
    const w = await world(2);
    await w.engine.run();
    // Offload P0 exactly as the offload service leaves it.
    const claim = remoteClaims(w.db).find((row) => row.id === 'P0');
    assert.ok(claim !== undefined);
    w.ledger.setStatus('P0', 'offloaded');
    await w.store.deleteOriginal(claim.contentHash);

    w.settings.providerId = 'prov-b';
    w.engine.oweManifest();
    const result = await w.engine.run();
    assert.equal(result.manifestUploaded, false, 'the backup fails truthfully');
    assert.equal(result.blockedRemoteOnly, 1);
    assert.equal((await w.providerB.list('manifest')).length, 0, 'no generation published on the target');
    assert.equal((await w.providerA.list('manifest')).length, 1, 'retained generation preserved');
    assert.equal(w.ledger.status('P0'), 'offloaded', 'the remote-only claim is never flipped to error');
    assert.deepEqual(result.integrity, { checked: 0, repaired: 0, unrecoverable: 0, recoveryRepaired: false, failed: false });
    assert.ok(w.audits.some((line) => line.startsWith('BACKUP-BLOCKED-REMOTE-ONLY provider=prov-b count=1')));

    // Restart: a fresh engine still owes the generation and still refuses.
    const restarted = new BackupEngine(w.deps);
    const again = await restarted.run();
    assert.equal(again.manifestUploaded, false);
    assert.equal(again.blockedRemoteOnly, 1);
    assert.equal((await w.providerB.list('manifest')).length, 0);
  });

  test('switching BACK to the provider that holds the offloaded objects publishes truthfully again', async () => {
    const w = await world(2);
    await w.engine.run();
    const claim = remoteClaims(w.db).find((row) => row.id === 'P0');
    assert.ok(claim !== undefined);
    w.ledger.setStatus('P0', 'offloaded');
    await w.store.deleteOriginal(claim.contentHash);
    w.settings.providerId = 'prov-b';
    w.engine.oweManifest();
    await w.engine.run();
    assert.equal((await w.providerB.list('manifest')).length, 0);

    // Back to the provider that actually holds P0's blob.
    w.settings.providerId = 'prov-a';
    const result = await w.engine.run();
    assert.equal(result.manifestUploaded, true);
    assert.equal(result.blockedRemoteOnly, 0);
    assert.equal((await w.providerA.list('manifest')).length, 2, 'a fresh truthful generation landed');
    assert.equal(w.ledger.status('P0'), 'offloaded');
  });
});

function guardDeps(overrides: Partial<ProviderSwitchGuardDeps> & Pick<ProviderSwitchGuardDeps, 'target'>): {
  deps: ProviderSwitchGuardDeps;
  calls: { dirty: string[]; healed: string[]; protectedRequeued: string[]; protectedHealed: string[]; owed: boolean[] };
  audits: string[];
} {
  const calls = {
    dirty: [] as string[],
    healed: [] as string[],
    protectedRequeued: [] as string[],
    protectedHealed: [] as string[],
    owed: [] as boolean[],
  };
  const audits: string[] = [];
  const deps: ProviderSwitchGuardDeps = {
    ordinaryClaims: () => [],
    protectedClaims: () => [],
    hasLocalOriginal: () => false,
    hasLocalProtected: () => false,
    ledger: {
      isDirty: () => false,
      markDirty: (photoId) => calls.dirty.push(photoId),
      repairStatus: (photoId, to) => calls.healed.push(`${photoId}:${to}`),
    },
    requeueProtected: (object) => calls.protectedRequeued.push(`${object.photoId}:${object.kind}`),
    healProtected: (object) => calls.protectedHealed.push(`${object.photoId}:${object.kind}`),
    markManifestOwed: () => calls.owed.push(true),
    audit: (line) => audits.push(line),
    ...overrides,
  };
  return { deps, calls, audits };
}

function protectedObject(overrides: Partial<ProtectedRemoteObject>): ProtectedRemoteObject {
  return {
    photoId: 'PP0',
    albumId: 'A0',
    blobRef: 'ab'.repeat(32),
    kind: 'original',
    status: 'offloaded',
    dirty: false,
    sha256: 'cd'.repeat(32),
    bytes: 100,
    ...overrides,
  };
}

describe('provider-switch guard (#741)', () => {
  const HASH = `a3${'0'.repeat(62)}`;
  const BLOB_PATH = `blobs/a3/${HASH}`;

  function emptyTarget(): StorageProvider {
    return providerWithId('target', new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-guard-')) }));
  }

  async function holdingTarget(paths: readonly string[]): Promise<StorageProvider> {
    const provider = emptyTarget();
    for (const path of paths) {
      await provider.put(path, Readable.from([Buffer.from('ciphertext')]));
    }
    return provider;
  }

  test('remote-only ordinary claims missing from the target fail the switch closed with a useful reason', async () => {
    const { deps, calls } = guardDeps({
      target: { providerId: 'target', provider: emptyTarget() },
      ordinaryClaims: () => [{ id: 'P0', contentHash: HASH, status: 'offloaded' }],
    });
    const verdict = await guardProviderSwitch(deps);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? '', /1 cloud-only original is not in this provider/u);
    assert.match(verdict.reason ?? '', /switch back to the provider that holds them/u);
    assert.deepEqual(calls.dirty, [], 'a refused switch mutates nothing');
    assert.deepEqual(calls.owed, []);
  });

  test('a target that proves it holds the remote-only objects is accepted; stuck error rows heal to offloaded', async () => {
    const { deps, calls, audits } = guardDeps({
      target: { providerId: 'target', provider: await holdingTarget([BLOB_PATH]) },
      // The incident shape: the wrong provider's integrity pass flipped the
      // remote-only row to 'error'; the holding provider un-traps it.
      ordinaryClaims: () => [{ id: 'P0', contentHash: HASH, status: 'error' }],
    });
    const verdict = await guardProviderSwitch(deps);
    assert.deepEqual(verdict, { ok: true, reason: null });
    assert.deepEqual(calls.healed, ['P0:offloaded']);
    assert.deepEqual(calls.owed, [true], 'the switch owes the target a fresh generation');
    assert.ok(audits.some((line) => line.startsWith('PROVIDER-SWITCH-HEALED photo=P0')));
    assert.ok(audits.some((line) => line.startsWith('PROVIDER-SWITCH-VERIFIED provider=target')));
  });

  test('locally available originals the target is missing are re-queued, not blockers', async () => {
    const { deps, calls } = guardDeps({
      target: { providerId: 'target', provider: emptyTarget() },
      ordinaryClaims: () => [{ id: 'P0', contentHash: HASH, status: 'synced' }],
      hasLocalOriginal: () => true,
    });
    const verdict = await guardProviderSwitch(deps);
    assert.equal(verdict.ok, true);
    assert.deepEqual(calls.dirty, ['P0']);
  });

  test('protected remote-only objects missing from the target fail the switch closed', async () => {
    const object = protectedObject({});
    const { deps } = guardDeps({
      target: { providerId: 'target', provider: emptyTarget() },
      protectedClaims: () => [object],
    });
    const verdict = await guardProviderSwitch(deps);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? '', /1 cloud-only original is not in this provider/u);
  });

  test('protected objects heal and re-queue under the same contract as ordinary rows', async () => {
    const stuck = protectedObject({ status: 'error' });
    const local = protectedObject({ photoId: 'PP1', blobRef: 'ef'.repeat(32), status: 'synced' });
    const stuckPath = `protected/${stuck.blobRef.slice(0, 2)}/${stuck.blobRef}.${stuck.kind}`;
    const { deps, calls } = guardDeps({
      target: { providerId: 'target', provider: await holdingTarget([stuckPath]) },
      protectedClaims: () => [stuck, local],
      hasLocalProtected: (_albumId, blobRef) => blobRef === local.blobRef,
    });
    const verdict = await guardProviderSwitch(deps);
    assert.equal(verdict.ok, true);
    assert.deepEqual(calls.protectedHealed, ['PP0:original']);
    assert.deepEqual(calls.protectedRequeued, ['PP1:original']);
  });

  test('an unverifiable target (listing failure) fails closed', async () => {
    const target = emptyTarget();
    const failing: StorageProvider = { ...target, list: () => Promise.reject(new Error('offline')) };
    const { deps } = guardDeps({
      target: { providerId: 'target', provider: failing },
      ordinaryClaims: () => [{ id: 'P0', contentHash: HASH, status: 'offloaded' }],
    });
    const verdict = await guardProviderSwitch(deps);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? '', /Could not verify/u);
  });

  test('a library with no remote claims switches without any provider round-trip', async () => {
    const target = emptyTarget();
    const failing: StorageProvider = { ...target, list: () => Promise.reject(new Error('never called')) };
    const { deps, calls } = guardDeps({ target: { providerId: 'target', provider: failing } });
    assert.deepEqual(await guardProviderSwitch(deps), { ok: true, reason: null });
    assert.deepEqual(calls.owed, []);
  });
});

test('protected objects preflight and re-queue under the same publication contract (#741)', async () => {
  const w = await world(1);
  await w.engine.run();
  const blobRef = 'ab'.repeat(32);
  const path = `protected/${blobRef.slice(0, 2)}/${blobRef}.original`;
  const sealed = Buffer.from('sealed').toString('base64');
  let reconciled: readonly string[] = [];
  let protectedRuns = 0;
  (w.deps as { protectedBackup: BackupEngineDeps['protectedBackup'] }).protectedBackup = {
    run: async () => {
      protectedRuns += 1;
      if (reconciled.length === 0) return { uploaded: 0, failed: 0 };
      // The re-queued object flows back through the verified upload path.
      await w.providerA.put(path, Readable.from([Buffer.from('protected-ciphertext')]));
      return { uploaded: 1, failed: 0 };
    },
    scrub: () => Promise.resolve({ checked: 0, repaired: 0, unrecoverable: 0, cycleComplete: true }),
    hasManifestDebt: () => false,
    reconcileMissing: (paths) => {
      reconciled = paths;
      return { requeued: paths.length, blocked: 0 };
    },
    snapshot: () => ({
      protectedAlbums: [
        {
          id: 'A0',
          credentialGeneration: 1,
          metadataGeneration: 1,
          credentialRecord: sealed,
          sealedMetadata: sealed,
          createdAt: '2026-07-23T00:00:00.000Z',
          updatedAt: '2026-07-23T00:00:00.000Z',
        },
      ],
      protectedPhotos: [
        {
          id: 'PP0',
          albumId: 'A0',
          blobRef,
          sealedMetadata: sealed,
          createdAt: '2026-07-23T00:00:00.000Z',
          updatedAt: '2026-07-23T00:00:00.000Z',
          objects: [{ kind: 'original', path, sha256: 'cd'.repeat(32), bytes: 20, status: 'synced' }],
        },
      ],
    }),
    settleManifest: () => undefined,
  };
  w.engine.oweManifest();
  const result = await w.engine.run();
  assert.equal(result.manifestUploaded, true, 'publication succeeded only after the protected object existed');
  assert.deepEqual(reconciled, [path]);
  assert.equal(protectedRuns, 2, 'the re-queued protected object uploaded within the same run');
  assert.equal((await w.providerA.list('manifest')).length, 2);
  assert.ok(w.audits.some((line) => line.startsWith('MANIFEST-INCOMPLETE count=1')));
});
