import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { BackupEngine, type BackupEngineDeps, type BackupSettings, type NetworkKind } from '../../src/main/backup/backup-engine.js';
import { createManifestDebtStore } from '../../src/main/backup/manifest-debt.js';
import { FaultInjectingProvider, MockProvider } from '../../src/main/backup/mock-provider.js';
import { ProviderError } from '../../src/main/backup/provider.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { claimsForContentHashes } from '../../src/main/db/backup-claims.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import { sampleJpeg } from '../../src/main/library/seed.js';
import type { EnvelopeKey } from '../../src/main/crypto/envelope.js';
import type { PhotoInsert, SyncStatus } from '../../src/shared/library/types.js';

const NO_INTEGRITY_FINDINGS = {
  checked: 0,
  repaired: 0,
  unrecoverable: 0,
  recoveryRepaired: false,
  failed: false,
} as const;

// #105 exit criteria against real components: mock-provider integration —
// a full backup clears pendingCount, a killed/failed run resumes, and the
// throttle / Wi-Fi / auto settings are respected (fault-injected).

async function world(count: number, overrides?: { settings?: Partial<BackupSettings>; network?: NetworkKind }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-backup-'));
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT OR IGNORE INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-13T00:00:00.000Z')`);
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
      importedAt: `2026-07-13T00:0${String(index % 10)}:00.000Z`,
      importSource: 'test',
      keyId: 1,
    } satisfies PhotoInsert);
  }
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-remote-')) });
  const faulty = new FaultInjectingProvider(provider);
  const ledger = new SyncLedger(db);
  const sleeps: number[] = [];
  const progress: [number, number][] = [];
  const pendingCounts: number[] = [];
  const audits: string[] = [];
  const syncUpdates: { id: string; syncState: SyncStatus }[] = [];
  let clock = 0;
  const settings: BackupSettings = {
    throttlePercent: null,
    wifiOnly: false,
    autoBackupOnImport: false,
    ...overrides?.settings,
  };
  const deps: BackupEngineDeps = {
    provider: faulty,
    ledger,
    dirtyPhotos: () => repo.dirtyPhotos(),
    encryptedStream: (hash) => store.getEncryptedStream(hash),
    sealManifest: (json) => Promise.resolve(Buffer.from(json)),
    sealRecoveryBootstrap: () => Buffer.from('recovery-bootstrap'),
    libraryId: () => '01JZZZZZZZZZZZZZZZZZZZZZZZ',
    manifestSnapshot: () => repo.manifestSnapshot(),
    settings: () => settings,
    network: () => overrides?.network ?? 'wifi',
    events: { progress: (done, total) => progress.push([done, total]) },
    now: () => (clock += 40),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    pendingCountChanged: (count) => pendingCounts.push(count),
    pendingCount: () => repo.pendingCount(),
    syncStateChanged: (updates) => syncUpdates.push(...updates),
    audit: (line) => audits.push(line),
    integrityScrub: () => Promise.resolve({ checked: 0, repaired: 0, unrecoverable: 0, cycleComplete: false }),
    recoveryGenerationHealthy: () => Promise.resolve(true),
    // #741 production wiring: preflight claim lookup, local presence, and
    // durable manifest debt all resolve against the same library DB.
    claimsForContentHashes: (hashes) => claimsForContentHashes(db, hashes),
    hasLocalOriginal: (hash) => store.hasOriginal(hash),
    manifestDebt: createManifestDebtStore(db),
  };
  return {
    deps,
    repo,
    ledger,
    store,
    provider,
    faulty,
    sleeps,
    progress,
    pendingCounts,
    audits,
    syncUpdates,
    engine: new BackupEngine(deps),
  };
}

describe('backup engine (#105)', () => {
  test('EXIT CRITERIA: a full backup clears pendingCount, uploads ciphertext as-is + a manifest', async () => {
    const w = await world(3);
    assert.equal(w.ledger.pendingCount(), 3);
    const result = await w.engine.run();
    assert.deepEqual(result, {
      uploaded: 3,
      failed: 0,
      manifestUploaded: true,
      skipped: null,
      integrity: NO_INTEGRITY_FINDINGS,
      blockedRemoteOnly: 0,
    });
    assert.equal(w.ledger.pendingCount(), 0);
    assert.equal(w.ledger.status('P0'), 'synced');
    assert.deepEqual(w.syncUpdates, [
      { id: 'P0', syncState: 'synced' },
      { id: 'P1', syncState: 'synced' },
      { id: 'P2', syncState: 'synced' },
    ]);
    assert.notEqual(w.ledger.lastBackupAt(), null);

    // Remote blob bytes are the LOCAL CIPHERTEXT, byte-for-byte.
    const [item] = w.repo.dirtyPhotos().length === 0 ? [{ contentHash: '' }] : [];
    void item;
    const rows = await w.provider.list('blobs');
    assert.equal(rows.length, 3);
    const first = rows[0];
    const remote = await buffer(await w.provider.getStream(first?.path ?? ''));
    const localHash = first?.path.split('/').at(-1) ?? '';
    const local = await buffer(w.store.getEncryptedStream(localHash));
    assert.deepEqual(remote, local);

    const manifests = await w.provider.list('manifest');
    assert.deepEqual(
      manifests.map((entry) => entry.path),
      ['manifest/gen-1.ovlk'],
    );
    // The manifest describes EVERY live photo, not the (now-clean) batch —
    // restore without a local DB depends on it (PR #203 review, P1).
    const sealed = await buffer(await w.provider.getStream('manifest/gen-1.ovlk'));
    const manifest = JSON.parse(sealed.toString('utf8')) as { schema: number; photos: { id: string }[] };
    assert.equal(manifest.schema, 6);
    assert.equal(manifest.photos.length, 3);
    assert.equal((await w.provider.list('recovery')).length, 1, 'the fresh-machine key bootstrap landed first');
    // Aggregate progress is ordered 0..3 over the batch.
    assert.deepEqual(w.progress[0], [0, 3]);
    assert.deepEqual(w.progress.at(-1), [3, 3]);
  });

  test('manifest generations advance and prune past N=2', async () => {
    const w = await world(1);
    await w.engine.run();
    w.ledger.markDirty('P0');
    await w.engine.run();
    w.ledger.markDirty('P0');
    await w.engine.run();
    const manifests = (await w.provider.list('manifest')).map((entry) => entry.path).sort();
    assert.deepEqual(manifests, ['manifest/gen-2.ovlk', 'manifest/gen-3.ovlk']);
  });

  test('EXIT CRITERIA: transient failures retry with backoff, then error; the next run RESUMES', async () => {
    const w = await world(2);
    w.faulty.arm('put');
    const first = await w.engine.run();
    assert.deepEqual({ uploaded: first.uploaded, failed: first.failed }, { uploaded: 0, failed: 2 });
    assert.equal(w.ledger.status('P0'), 'error');
    assert.equal(w.ledger.pendingCount(), 2, 'errored rows stay dirty');
    // Two items × two backoffs (500, 1000) before the third attempt fails.
    assert.deepEqual(w.sleeps, [500, 1000, 500, 1000]);

    w.faulty.disarm('put');
    const second = await w.engine.run();
    assert.deepEqual({ uploaded: second.uploaded, failed: second.failed }, { uploaded: 2, failed: 0 });
    assert.equal(w.ledger.pendingCount(), 0, 'the dirty set is the resume state');
  });

  test('pending counts are tracked incrementally — never a re-materialized dirty set (113K-import freeze)', async () => {
    const w = await world(3);
    await w.engine.run();
    assert.deepEqual(w.pendingCounts, [2, 1, 0], 'each verified upload decrements once');

    const failing = await world(2);
    failing.faulty.arm('put');
    await failing.engine.run();
    assert.deepEqual(failing.pendingCounts, [2, 2], 'failed rows stay pending');
    assert.equal(failing.ledger.pendingCount(), 2, 'emitted count matches the ledger');
  });

  test('a row dirtied mid-run survives the incremental count: the final emission is the live DB count (PR #831 review)', async () => {
    const w = await world(3);
    const originalProgress = w.deps.events.progress.bind(w.deps.events);
    w.deps.events.progress = (done, total, photoId) => {
      originalProgress(done, total, photoId);
      // An edit lands between uploads — after P0 is synced, its user dirties
      // it again. The markDirty site emits its own live count in production;
      // a later per-item emission must not bury it under the stale snapshot.
      if (done === 2) {
        w.ledger.markDirty('P0');
      }
    };
    await w.engine.run();
    assert.equal(w.repo.pendingCount(), 1, 'the mid-run edit is next-run work');
    assert.deepEqual(w.pendingCounts, [2, 1, 0, 1], 'the run ends by reconciling to the authoritative count');
  });

  test('object-scoped transient failures never trip the circuit breaker', async () => {
    const w = await world(12);
    (w.deps.provider as { put: typeof w.deps.provider.put }).put = () =>
      Promise.reject(new ProviderError('object busy', 'transient', 'object'));
    const result = await w.engine.run();
    assert.deepEqual({ uploaded: result.uploaded, failed: result.failed }, { uploaded: 0, failed: 12 });
    assert.equal(
      w.audits.some((line) => line.startsWith('BACKUP-CIRCUIT-BREAKER')),
      false,
      'per-object trouble is not provider-outage evidence',
    );
  });

  test('circuit breaker: 10 consecutive transient failures abort the sweep; dirty rows resume next run', async () => {
    const w = await world(12);
    w.faulty.arm('put');
    const first = await w.engine.run();
    assert.deepEqual({ uploaded: first.uploaded, failed: first.failed }, { uploaded: 0, failed: 10 });
    const statuses = w.repo.dirtyPhotos().map((row) => row.status);
    assert.equal(statuses.filter((status) => status === 'error').length, 10);
    assert.equal(statuses.filter((status) => status === 'local').length, 2, 'the breaker spared the tail');
    assert.ok(w.audits.some((line) => line.startsWith('BACKUP-CIRCUIT-BREAKER consecutive=10')));
    assert.equal(w.ledger.pendingCount(), 12, 'nothing lost — the dirty set is the resume state');

    w.faulty.disarm('put');
    const second = await w.engine.run();
    assert.deepEqual({ uploaded: second.uploaded, failed: second.failed }, { uploaded: 12, failed: 0 });
    assert.equal(w.ledger.pendingCount(), 0);
  });

  test('auth failure stops the run — retrying the rest cannot help', async () => {
    const w = await world(3);
    w.faulty.arm('auth-expired');
    const result = await w.engine.run();
    assert.deepEqual({ uploaded: result.uploaded, failed: result.failed }, { uploaded: 0, failed: 1 });
    assert.equal(w.ledger.status('P0'), 'error');
    assert.equal(w.ledger.status('P1'), 'local', 'the rest were never attempted');
    assert.deepEqual(w.syncUpdates, [{ id: 'P0', syncState: 'error' }]);
  });

  test('EXIT CRITERIA: the Wi-Fi gate skips on metered; unknown interfaces proceed (recorded heuristic)', async () => {
    const gated = await world(1, { settings: { wifiOnly: true }, network: 'other' });
    assert.deepEqual(await gated.engine.run(), {
      uploaded: 0,
      failed: 0,
      manifestUploaded: true,
      skipped: 'wifi',
      integrity: NO_INTEGRITY_FINDINGS,
      blockedRemoteOnly: 0,
    });
    assert.equal(gated.ledger.pendingCount(), 1);

    const unknown = await world(1, { settings: { wifiOnly: true }, network: 'unknown' });
    assert.equal((await unknown.engine.run()).uploaded, 1);
  });

  test('EXIT CRITERIA: throttle rests between items; unlimited never sleeps', async () => {
    const throttled = await world(2, { settings: { throttlePercent: 50 } });
    await throttled.engine.run();
    const rests = throttled.sleeps.filter((ms) => ms > 0);
    assert.equal(rests.length, 2, 'one rest per item at 50%');

    const unlimited = await world(2);
    await unlimited.engine.run();
    assert.deepEqual(unlimited.sleeps, []);
  });

  test('EXIT CRITERIA (#106): a verify mismatch goes error + stays dirty (re-queued); audit records it', async () => {
    const w = await world(1);
    w.faulty.arm('verify-mismatch');
    const result = await w.engine.run();
    assert.deepEqual({ uploaded: result.uploaded, failed: result.failed }, { uploaded: 0, failed: 1 });
    assert.equal(w.ledger.status('P0'), 'error', 'the cloud-alert state');
    assert.equal(w.ledger.pendingCount(), 1, 're-queued for the next run');
    assert.ok(w.audits.some((line) => line.startsWith('VERIFY-MISMATCH photo=P0')));

    // Healed: the next run verifies clean and the audit says so.
    w.faulty.disarm('verify-mismatch');
    const second = await w.engine.run();
    assert.equal(second.uploaded, 1);
    assert.equal(w.ledger.status('P0'), 'synced');
    assert.ok(w.audits.some((line) => line.startsWith('VERIFY-OK photo=P0')));
  });

  test('a row killed mid-upload (already syncing, still dirty) RESUMES (PR #203 review)', async () => {
    const w = await world(1);
    w.ledger.setStatus('P0', 'syncing'); // the kill left it here
    const result = await w.engine.run();
    assert.deepEqual({ uploaded: result.uploaded, failed: result.failed }, { uploaded: 1, failed: 0 });
    assert.equal(w.ledger.status('P0'), 'synced');
  });

  test('a failed manifest upload is owed and retried by the NEXT run (PR #203 review)', async () => {
    const w = await world(1);
    // Blobs succeed; the manifest list/put path fails transiently.
    w.faulty.arm('transient-get'); // does not affect put/list
    const originalList = w.deps.provider.list.bind(w.deps.provider);
    let failLists = true;
    (w.deps.provider as { list: typeof originalList }).list = (prefix) => {
      if (failLists && prefix === 'manifest') {
        failLists = false;
        return Promise.reject(new Error('manifest listing exploded'));
      }
      return originalList(prefix);
    };
    const first = await w.engine.run();
    assert.equal(first.uploaded, 1);
    assert.equal(first.manifestUploaded, false, 'the run reports the owed manifest');
    assert.equal(w.ledger.pendingCount(), 0, 'blob rows are truthfully synced');

    // Nothing dirty — the next run still settles the debt.
    const second = await w.engine.run();
    assert.equal(second.manifestUploaded, true);
    assert.equal((await w.provider.list('manifest')).length, 1);
  });

  test('oweManifest(): a clean-world run still uploads a fresh generation (PR #218 review)', async () => {
    const w = await world(1);
    await w.engine.run();
    assert.equal((await w.provider.list('manifest')).length, 1);

    // Nothing dirty, nothing owed: a run uploads no new generation.
    await w.engine.run();
    assert.equal((await w.provider.list('manifest')).length, 1);

    // A soft delete of a synced row changes manifestSnapshot() with pending 0 —
    // the owed generation must land or a backup restore resurrects it.
    w.engine.oweManifest();
    const settle = await w.engine.run();
    assert.equal(settle.manifestUploaded, true);
    assert.equal((await w.provider.list('manifest')).length, 2, 'a new generation landed');
  });

  test('auto-backup-on-import runs only when the setting says so', async () => {
    const off = await world(1);
    off.engine.maybeAutoRun();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(off.ledger.pendingCount(), 1);

    const on = await world(1, { settings: { autoBackupOnImport: true } });
    on.engine.maybeAutoRun();
    // maybeAutoRun is fire-and-forget — poll for the drain instead of racing
    // it with a fixed sleep (50ms flaked on a loaded CI runner).
    const deadline = Date.now() + 10_000;
    while (on.ledger.pendingCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(on.ledger.pendingCount(), 0);
  });

  test('a dirty OFFLOADED row is manifest-only debt: settled by the generation, never uploaded (PR #274 review)', async () => {
    const w = await world(2);
    // Backup everything, then offload P0 the way the offload service leaves
    // it: synced -> offloaded, clean.
    await w.engine.run();
    w.ledger.setStatus('P0', 'offloaded');
    // An edit in the Offloaded view (album add, favorite) dirties the row.
    w.ledger.markDirty('P0');
    assert.equal(w.ledger.pendingCount(), 1);

    const blobsBefore = (await w.provider.list('blobs')).length;
    const result = await w.engine.run();

    // No blob traveled and nothing failed -- the run did not crash on the
    // offloaded -> syncing transition (the pre-#274 behavior)...
    assert.deepEqual(result, {
      uploaded: 0,
      failed: 0,
      manifestUploaded: true,
      skipped: null,
      integrity: NO_INTEGRITY_FINDINGS,
      blockedRemoteOnly: 0,
    });
    assert.equal((await w.provider.list('blobs')).length, blobsBefore);
    // ...a fresh manifest generation carried the edit...
    const manifests = await w.provider.list('manifest');
    assert.equal(manifests.length, 2);
    // ...and the dirt settled with the status untouched.
    assert.equal(w.ledger.pendingCount(), 0);
    assert.equal(w.ledger.status('P0'), 'offloaded');
  });

  test('a failed manifest upload keeps offloaded dirt pending -- the next run settles it (debt survives)', async () => {
    const w = await world(1);
    await w.engine.run();
    w.ledger.setStatus('P0', 'offloaded');
    w.ledger.markDirty('P0');
    w.faulty.arm('put');
    const failed = await w.engine.run();
    assert.equal(failed.manifestUploaded, false);
    assert.equal(w.ledger.pendingCount(), 1, 'unsettled dirt stays visible');
    w.faulty.disarm('put');
    const retried = await w.engine.run();
    assert.equal(retried.manifestUploaded, true);
    assert.equal(w.ledger.pendingCount(), 0);
    assert.equal(w.ledger.status('P0'), 'offloaded');
  });

  test('confirmed remote-only loss fails the backup: no publish, no prune, retained generations intact (#741)', async () => {
    const w = await world(1);
    (w.deps as { integrityScrub: BackupEngineDeps['integrityScrub'] }).integrityScrub = () =>
      Promise.resolve({ checked: 50, repaired: 2, unrecoverable: 1, cycleComplete: false });

    const result = await w.engine.run();
    assert.deepEqual(result.integrity, {
      checked: 50,
      repaired: 2,
      unrecoverable: 1,
      recoveryRepaired: false,
      failed: false,
    });
    // The batch generation landed BEFORE the loss was confirmed; the loss
    // must never publish the old "refreshed" generation on top of it.
    assert.deepEqual(
      (await w.provider.list('manifest')).map((entry) => entry.path),
      ['manifest/gen-1.ovlk'],
      'the retained generation is preserved; no refresh published',
    );
    assert.equal(result.manifestUploaded, false, 'the run fails truthfully');
    assert.ok(!w.audits.includes('INTEGRITY-MANIFEST-REFRESHED'));
    assert.ok(w.audits.includes('INTEGRITY-PUBLISH-BLOCKED unrecoverable=1'));
  });

  test('confirmed loss leaves durable debt: a restarted engine still owes the generation and a clean run settles it (#741)', async () => {
    const w = await world(1);
    (w.deps as { integrityScrub: BackupEngineDeps['integrityScrub'] }).integrityScrub = () =>
      Promise.resolve({ checked: 1, repaired: 0, unrecoverable: 1, cycleComplete: true });
    const blocked = await w.engine.run();
    assert.equal(blocked.manifestUploaded, false);
    assert.equal((await w.provider.list('manifest')).length, 1);

    // The loss resolves (photo deleted / re-imported); a FRESH engine —
    // the restart — must still know the remote is owed a generation.
    (w.deps as { integrityScrub: BackupEngineDeps['integrityScrub'] }).integrityScrub = () =>
      Promise.resolve({ checked: 0, repaired: 0, unrecoverable: 0, cycleComplete: true });
    const restarted = new BackupEngine(w.deps);
    const settled = await restarted.run();
    assert.equal(settled.manifestUploaded, true);
    assert.equal((await w.provider.list('manifest')).length, 2, 'the owed generation landed after restart');
  });

  test('an integrity provider failure is audited without losing completed uploads', async () => {
    const w = await world(1);
    (w.deps as { integrityScrub: BackupEngineDeps['integrityScrub'] }).integrityScrub = () =>
      Promise.reject(new Error('provider unavailable'));

    const result = await w.engine.run();
    assert.equal(result.uploaded, 1);
    assert.deepEqual(result.integrity, {
      checked: 0,
      repaired: 0,
      unrecoverable: 0,
      recoveryRepaired: false,
      failed: true,
    });
    assert.ok(w.audits.includes('INTEGRITY-CHECK-FAILED reason=provider unavailable'));
  });

  test('publication preflight: a restarted engine refuses an incomplete generation, then repairs it from the local original (#741)', async () => {
    const w = await world(2);
    await w.engine.run();
    const [lost] = await w.provider.list('blobs');
    assert.ok(lost !== undefined);
    await w.provider.delete(lost.path);

    // A fresh engine (restart: no presence cache, no verified-upload notes)
    // owes a generation — publication must preflight, refuse, and re-upload
    // from the local original within the run.
    const restarted = new BackupEngine(w.deps);
    restarted.oweManifest();
    const result = await restarted.run();
    assert.equal(result.manifestUploaded, true);
    assert.equal(result.blockedRemoteOnly, 0);
    assert.equal(result.uploaded, 1, 'the missing blob re-uploaded from local');
    assert.ok(w.audits.some((line) => line.startsWith('MANIFEST-INCOMPLETE count=1')));
    assert.equal((await w.provider.list('blobs')).length, 2, 'the provider holds every referenced blob again');
    assert.equal((await w.provider.list('manifest')).length, 2);
  });

  test('publication preflight fails closed when a referenced blob is remote-only and absent (#741)', async () => {
    const w = await world(1);
    await w.engine.run();
    const [lost] = await w.provider.list('blobs');
    assert.ok(lost !== undefined);
    await w.provider.delete(lost.path);
    const contentHash = lost.path.split('/').at(-1) ?? '';
    await w.store.deleteOriginal(contentHash);

    const restarted = new BackupEngine(w.deps);
    restarted.oweManifest();
    const result = await restarted.run();
    assert.equal(result.manifestUploaded, false, 'no incomplete generation publishes');
    assert.equal(result.blockedRemoteOnly, 1);
    assert.deepEqual(
      (await w.provider.list('manifest')).map((entry) => entry.path),
      ['manifest/gen-1.ovlk'],
      'nothing published, nothing pruned',
    );
    assert.equal(w.ledger.status('P0'), 'synced', 'the claim is never flipped by the publication path');
    assert.ok(w.audits.some((line) => line.startsWith('BACKUP-BLOCKED-REMOTE-ONLY')));
    assert.deepEqual(result.integrity, NO_INTEGRITY_FINDINGS, 'no scrub runs against unprovable claims');
  });

  test('a failed recovery-repair refresh remains debt for the next clean run', async () => {
    const w = await world(1);
    await w.engine.run();
    (w.deps as { recoveryGenerationHealthy: BackupEngineDeps['recoveryGenerationHealthy'] }).recoveryGenerationHealthy = () => {
      w.faulty.arm('put');
      return Promise.resolve(false);
    };

    const failed = await w.engine.run();
    assert.equal(failed.manifestUploaded, false);
    assert.equal(failed.integrity.failed, true);
    assert.equal((await w.provider.list('manifest')).length, 1);

    w.faulty.disarm('put');
    (w.deps as { recoveryGenerationHealthy: BackupEngineDeps['recoveryGenerationHealthy'] }).recoveryGenerationHealthy = () =>
      Promise.resolve(true);
    const retried = await w.engine.run();
    assert.equal(retried.manifestUploaded, true);
    assert.equal((await w.provider.list('manifest')).length, 2);
  });

  test('a damaged recovery index publishes and verifies a fresh generation', async () => {
    const w = await world(1);
    (w.deps as { recoveryGenerationHealthy: BackupEngineDeps['recoveryGenerationHealthy'] }).recoveryGenerationHealthy = () =>
      Promise.resolve(false);

    const result = await w.engine.run();
    assert.equal(result.integrity.recoveryRepaired, true);
    assert.equal((await w.provider.list('manifest')).length, 2);
    assert.ok(w.audits.includes('INTEGRITY-RECOVERY-REPAIRED'));
  });
});
