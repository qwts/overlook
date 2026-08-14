import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';

import { buildBackupManifestV2 } from '../../src/main/backup/backup-manifest.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { ProviderError } from '../../src/main/backup/provider.js';
import { sealRecoveryBootstrap } from '../../src/main/backup/recovery-bootstrap.js';
import { RestoreCoordinator, type RestoreRunner } from '../../src/main/backup/restore-coordinator.js';
import { RestoreEngine, type RestoreEngineDeps, type RestoreVerifyResult } from '../../src/main/backup/restore-engine.js';
import type { RestoreProgress } from '../../src/main/backup/restore-types.js';
import { createEncryptStream } from '../../src/main/crypto/envelope.js';
import { KeyStore, type SafeStorageLike } from '../../src/main/crypto/keystore.js';
import { sealRecoveryKey } from '../../src/main/crypto/recovery.js';
import { sampleJpeg } from '../../src/main/library/seed.js';

const LIBRARY_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const GENERATED_AT = '2026-07-15T01:00:00.000Z';
const PASSWORD = 'correct horse battery staple';
const OBJECT_SET_SHA256 = '0'.repeat(64);

const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => value.toString('utf8'),
};

async function put(provider: MockProvider, path: string, bytes: Buffer): Promise<void> {
  await provider.put(path, Readable.from([bytes]));
}

async function remoteWorld(libraryId = LIBRARY_ID, corruptPhoto?: 'decryptable' | 'authentication') {
  const sourceDir = mkdtempSync(join(tmpdir(), 'restore-coordinator-source-'));
  const keys = KeyStore.open({ safeStorage, dataDir: sourceDir });
  const masterKey = keys.masterKeyBytes();
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'restore-coordinator-remote-')), libraryId });
  await put(
    provider,
    'recovery/bootstrap.ovrb',
    sealRecoveryBootstrap({ schema: 1, libraryId, generatedAt: GENERATED_AT, keys: keys.exportWrappedKeys() }, masterKey),
  );
  const expectedImage = sampleJpeg(41);
  const corruptImage = sampleJpeg(42);
  const contentHash = createHash('sha256').update(expectedImage).digest('hex');
  const photo = {
    id: 'P1',
    fileName: 'IMG_1.JPG',
    fileKind: 'jpeg' as const,
    mediaInfo: null,
    width: 1,
    height: 1,
    bytes: expectedImage.length,
    contentHash,
    blobPath: `blobs/${contentHash.slice(0, 2)}/${contentHash}`,
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
    importedAt: GENERATED_AT,
    importSource: 'cloud-restore',
    favorite: false,
    keyId: 1,
    deletedAt: null,
  };
  const photos = corruptPhoto === undefined ? [] : [photo];
  if (corruptPhoto !== undefined) {
    const bytes =
      corruptPhoto === 'authentication'
        ? Buffer.from('not an authenticated envelope')
        : await buffer(Readable.from([corruptImage]).pipe(createEncryptStream(keys.currentKey(), { photoId: photo.id })));
    await put(provider, photo.blobPath, bytes);
  }
  const manifest = buildBackupManifestV2({
    libraryId,
    generatedAt: GENERATED_AT,
    snapshot: {
      databaseSchema: 3,
      keyIds: [1],
      totals: { photos: photos.length, bytes: photos.reduce((total, item) => total + item.bytes, 0), albums: 0 },
      photos,
      albums: [],
    },
  });
  const sealed = await buffer(
    Readable.from([Buffer.from(JSON.stringify(manifest))]).pipe(createEncryptStream(keys.currentKey(), { photoId: 'manifest' })),
  );
  await put(provider, 'manifest/gen-2.ovlk', sealed);
  return { provider, masterKey, recoveryFile: sealRecoveryKey(masterKey, PASSWORD), corruptImage, photo };
}

function engineRunner(provider: MockProvider): RestoreRunner {
  const deps: RestoreEngineDeps = {
    provider,
    targetDir: join(mkdtempSync(join(tmpdir(), 'restore-coordinator-target-')), 'library'),
    safeStorage,
    availableBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    thumbnails: () => ({ generateFor: () => Promise.resolve({ generated: true, width: 1, height: 1 }) }),
    events: { progress: () => undefined },
  };
  const engine = new RestoreEngine(deps);
  return { run: (request) => engine.run(request), verify: (request) => engine.verify(request) };
}

function completeVerification(): RestoreVerifyResult {
  return {
    libraryId: LIBRARY_ID,
    generation: 2,
    manifestPath: 'manifest/gen-2.ovlk',
    sealedManifestSha256: '1'.repeat(64),
    objectSetSha256: OBJECT_SET_SHA256,
    photos: 0,
    missing: [],
    missingCount: 0,
    corruptCount: 0,
    verifiedCount: 0,
  };
}

function verifiedRunner(run: RestoreRunner['run']): RestoreRunner {
  return { run, verify: () => Promise.resolve(completeVerification()) };
}

async function verificationId(coordinator: RestoreCoordinator, sessionId: string): Promise<string> {
  const response = await coordinator.verify(sessionId, LIBRARY_ID);
  assert.equal(response.error, null);
  assert.ok(response.result);
  return response.result.verificationId;
}

test('restore coordinator discovers validated metadata and runs through an opaque session (#290)', async () => {
  const world = await remoteWorld();
  const progress: RestoreProgress[] = [];
  let activated = false;
  const runner: RestoreRunner = {
    run: ({ signal }) => {
      assert.equal(signal?.aborted, false);
      return Promise.resolve({ libraryId: LIBRARY_ID, generation: 2, photos: 0, resumed: false, missing: [] });
    },
    verify: () => Promise.resolve(completeVerification()),
  };
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: (_provider, emit) => {
      emit({ stage: 'discovering', done: 0, total: 0, photoId: null });
      return runner;
    },
    sessionId: () => 'session-1',
    resumeAvailable: () => Promise.resolve(true),
    progress: (value) => progress.push(value),
    activated: () => {
      activated = true;
    },
  });

  const discovered = await coordinator.discover('mock', '/recovery.key', PASSWORD);
  assert.equal(discovered.sessionId, 'session-1');
  assert.deepEqual(discovered.libraries, [
    {
      libraryId: LIBRARY_ID,
      generation: 2,
      generatedAt: GENERATED_AT,
      photos: 0,
      totalBytes: 0,
      albums: 0,
      compatibility: 'compatible',
      validation: 'valid',
      fallbackGenerations: 0,
      resumable: true,
    },
  ]);
  const run = await coordinator.run('session-1', LIBRARY_ID, await verificationId(coordinator, 'session-1'), false);
  assert.equal(run.error, null);
  assert.equal(run.result?.relaunching, false);
  assert.equal(activated, true);
  assert.deepEqual(
    progress.map(({ stage }) => stage),
    ['discovering', 'discovering'],
    'verification and the bound restore each report their runner lifecycle',
  );
  assert.equal((await coordinator.run('session-1', LIBRARY_ID, 'expired-plan', false)).error?.message.includes('expired'), true);
});

test('wrong recovery password fails before provider discovery', async () => {
  const world = await remoteWorld();
  let sourceCalls = 0;
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => {
      sourceCalls += 1;
      return Promise.resolve([]);
    },
    createRunner: () => ({ run: () => Promise.reject(new Error('unused')) }),
    sessionId: () => 'unused',
    progress: () => undefined,
  });
  const result = await coordinator.discover('mock', '/recovery.key', 'wrong password');
  assert.equal(result.error?.reason, 'wrong-key');
  assert.equal(sourceCalls, 0);
});

test('discovery reports an authenticated provider scope with no cloud libraries', async () => {
  const world = await remoteWorld();
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => Promise.resolve([]),
    createRunner: () => ({ run: () => Promise.reject(new Error('unused')) }),
    sessionId: () => 'unused',
    progress: () => undefined,
  });

  const result = await coordinator.discover('mock', '/recovery.key', PASSWORD);
  assert.equal(result.sessionId, null);
  assert.deepEqual(result.libraries, []);
  assert.deepEqual(result.error, { reason: 'corrupt', message: 'No Overlook cloud libraries were found.' });
});

test('cancelled runs preserve discovery but require a fresh verification for resumable retry', async () => {
  const world = await remoteWorld();
  let attempt = 0;
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () =>
      verifiedRunner(async ({ signal }) => {
        attempt += 1;
        if (attempt > 1) return { libraryId: LIBRARY_ID, generation: 2, photos: 0, resumed: true, missing: [] };
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
        throw new Error('unreachable');
      }),
    sessionId: () => 'session-resume',
    progress: () => undefined,
  });
  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  const firstPlan = await verificationId(coordinator, 'session-resume');
  const first = coordinator.run('session-resume', LIBRARY_ID, firstPlan, false);
  coordinator.cancel();
  assert.equal((await first).error?.reason, 'cancelled');
  assert.match((await coordinator.run('session-resume', LIBRARY_ID, firstPlan, false)).error?.message ?? '', /verification expired/u);
  const retryPlan = await verificationId(coordinator, 'session-resume');
  assert.equal((await coordinator.run('session-resume', LIBRARY_ID, retryPlan, false)).result?.resumed, true);
});

test('close drains an active discovery and destroys its recovered session', async () => {
  const world = await remoteWorld();
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: async () => {
      entered?.();
      await gate;
      return [{ libraryId: LIBRARY_ID, provider: world.provider }];
    },
    createRunner: () => ({ run: () => Promise.reject(new Error('unused')) }),
    sessionId: () => 'session-close',
    progress: () => undefined,
  });
  const discovery = coordinator.discover('mock', '/recovery.key', PASSWORD);
  await started;
  let closed = false;
  const closing = coordinator.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release?.();
  assert.equal((await discovery).sessionId, 'session-close');
  await closing;
  assert.equal(closed, true);
  assert.equal((await coordinator.run('session-close', LIBRARY_ID, 'expired-plan', false)).error?.message.includes('expired'), true);
});

test("this Mac's stored master key discovers and restores without a recovery-key file (#741)", async () => {
  const world = await remoteWorld();
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.reject(new Error('the key file must not be read')),
    localMasterKey: () => Buffer.from(world.masterKey),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () =>
      verifiedRunner(() => Promise.resolve({ libraryId: LIBRARY_ID, generation: 2, photos: 0, resumed: false, missing: [] })),
    sessionId: () => 'session-local-key',
    progress: () => undefined,
  });
  const discovery = await coordinator.discoverFrom('mock', { kind: 'local-master' });
  assert.equal(discovery.error, null);
  assert.equal(discovery.sessionId, 'session-local-key');
  assert.equal(discovery.libraries[0]?.validation, 'valid');
  const run = await coordinator.run('session-local-key', LIBRARY_ID, await verificationId(coordinator, 'session-local-key'), false);
  assert.equal(run.error, null);
  assert.equal(run.result?.generation, 2);
});

test('an unavailable local master key fails with recovery-key guidance, never a crash (#741)', async () => {
  const world = await remoteWorld();
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.reject(new Error('unused')),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () => ({ run: () => Promise.reject(new Error('unused')) }),
    sessionId: () => 'session-no-local',
    progress: () => undefined,
  });
  const discovery = await coordinator.discoverFrom('mock', { kind: 'local-master' });
  assert.equal(discovery.sessionId, null);
  assert.equal(discovery.error?.reason, 'wrong-key');
  assert.match(discovery.error?.message ?? '', /recovery key/u);
});

test('expireSession makes a discovered session unrunnable but never disturbs an active run (#757 review)', async () => {
  const world = await remoteWorld();
  let attempt = 0;
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () =>
      verifiedRunner(async ({ signal }) => {
        attempt += 1;
        if (attempt > 1) return { libraryId: LIBRARY_ID, generation: 2, photos: 0, resumed: false, missing: [] };
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
        throw new Error('unreachable');
      }),
    sessionId: () => 'session-expire',
    progress: () => undefined,
  });
  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  const firstPlan = await verificationId(coordinator, 'session-expire');
  const running = coordinator.run('session-expire', LIBRARY_ID, firstPlan, false);
  coordinator.expireSession();
  coordinator.cancel();
  assert.equal((await running).error?.reason, 'cancelled', 'the active run kept its session key');
  assert.equal(
    (await coordinator.run('session-expire', LIBRARY_ID, await verificationId(coordinator, 'session-expire'), false)).result?.resumed,
    false,
    'the mid-run expire was a no-op: the cancelled session stayed retryable',
  );

  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  coordinator.expireSession();
  assert.equal(
    (await coordinator.run('session-expire', LIBRARY_ID, 'expired-plan', false)).error?.message.includes('expired'),
    true,
    'an idle expire drops the session',
  );
});

test('the verified custody password rides the session into the runner request (#754)', async () => {
  const world = await remoteWorld();
  const requests: { custodyPassword?: string | undefined }[] = [];
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.reject(new Error('the key file must not be read')),
    localMasterKey: () => Buffer.from(world.masterKey),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () =>
      verifiedRunner((request) => {
        requests.push(request);
        return Promise.resolve({ libraryId: LIBRARY_ID, generation: 2, photos: 0, resumed: false, missing: [] });
      }),
    sessionId: () => 'session-custody',
    progress: () => undefined,
  });
  const discovery = await coordinator.discoverFrom('mock', { kind: 'local-master', custodyPassword: 'app pw' });
  assert.equal(discovery.error, null);
  await coordinator.run('session-custody', LIBRARY_ID, await verificationId(coordinator, 'session-custody'), false);
  assert.equal(requests[0]?.custodyPassword, 'app pw');
});

test('recovery-key sessions never carry a custody password (#754)', async () => {
  const world = await remoteWorld();
  const requests: { custodyPassword?: string | undefined }[] = [];
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () =>
      verifiedRunner((request) => {
        requests.push(request);
        return Promise.resolve({ libraryId: LIBRARY_ID, generation: 2, photos: 0, resumed: false, missing: [] });
      }),
    sessionId: () => 'session-rk',
    progress: () => undefined,
  });
  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  await coordinator.run('session-rk', LIBRARY_ID, await verificationId(coordinator, 'session-rk'), false);
  assert.equal('custodyPassword' in (requests[0] ?? {}), false);
});

test("a foreign library's local key surfaces per-library wrong-key validation, never a valid session (#741)", async () => {
  const world = await remoteWorld();
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.reject(new Error('unused')),
    localMasterKey: () => Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () => ({ run: () => Promise.reject(new Error('unused')) }),
    sessionId: () => 'session-wrong-local',
    progress: () => undefined,
  });
  const discovery = await coordinator.discoverFrom('mock', { kind: 'local-master' });
  assert.notEqual(discovery.libraries[0]?.validation, 'valid');
  const run = await coordinator.run('session-wrong-local', LIBRARY_ID, 'no-plan', false);
  assert.notEqual(run.error, null, 'an unvalidated library can never run');
});

test('one unreadable namespace cannot block a later valid restore source (#751)', async () => {
  const world = await remoteWorld();
  const unreadable = new MockProvider({
    rootDir: mkdtempSync(join(tmpdir(), 'restore-coordinator-unreadable-')),
    libraryId: '01JUNREADABLENAMESPACE00001',
  });
  unreadable.getStream = () => Promise.reject(new ProviderError('namespace could not materialize', 'transient', 'object'));
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () =>
      Promise.resolve([
        { libraryId: '01JUNREADABLENAMESPACE00001', provider: unreadable },
        { libraryId: LIBRARY_ID, provider: world.provider },
      ]),
    createRunner: () => ({ run: () => Promise.reject(new Error('unused')) }),
    sessionId: () => 'session-after-unreadable',
    progress: () => undefined,
  });

  const discovery = await coordinator.discover('icloud-drive', '/recovery.key', PASSWORD);
  assert.equal(discovery.error, null);
  assert.equal(discovery.sessionId, 'session-after-unreadable');
  assert.deepEqual(
    discovery.libraries.map(({ libraryId, validation }) => ({ libraryId, validation })),
    [
      { libraryId: '01JUNREADABLENAMESPACE00001', validation: 'corrupt' },
      { libraryId: LIBRARY_ID, validation: 'valid' },
    ],
  );
});

test('a matching restore stops before unrelated delayed namespaces (#751)', async () => {
  const world = await remoteWorld();
  const delayed = new MockProvider({
    rootDir: mkdtempSync(join(tmpdir(), 'restore-coordinator-delayed-')),
    libraryId: '01JDELAYEDNAMESPACE0000001',
  });
  let delayedReads = 0;
  delayed.getStream = () => {
    delayedReads += 1;
    return Promise.reject(new ProviderError('namespace could not materialize', 'transient', 'object'));
  };
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () =>
      Promise.resolve([
        { libraryId: LIBRARY_ID, provider: world.provider },
        { libraryId: '01JDELAYEDNAMESPACE0000001', provider: delayed },
      ]),
    createRunner: () => ({ run: () => Promise.reject(new Error('unused')) }),
    sessionId: () => 'session-before-delayed',
    progress: () => undefined,
  });

  const discovery = await coordinator.discover('icloud-drive', '/recovery.key', PASSWORD);
  assert.equal(discovery.error, null);
  assert.equal(discovery.libraries[0]?.validation, 'valid');
  assert.equal(delayedReads, 0);
});

test('corrupt-image export writes only decryptable image plaintext and reports authentication failures', async () => {
  for (const mode of ['decryptable', 'authentication'] as const) {
    const world = await remoteWorld(LIBRARY_ID, mode);
    const runner = engineRunner(world.provider);
    const runVerify = runner.verify?.bind(runner);
    assert.ok(runVerify);
    const coordinator = new RestoreCoordinator({
      readRecoveryKey: () => Promise.resolve(world.recoveryFile),
      sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
      createRunner: () => ({
        run: runner.run.bind(runner),
        verify: async (request) => {
          const current = await runVerify(request);
          return {
            ...current,
            missing: [{ path: world.photo.blobPath, kind: 'original', photoId: world.photo.id, reason: 'failed-verification' }],
            missingCount: 0,
            corruptCount: 1,
            verifiedCount: 0,
          };
        },
      }),
      sessionId: () => `session-export-${mode}`,
      progress: () => undefined,
    });
    const sessionId = `session-export-${mode}`;
    assert.equal((await coordinator.discover('mock', '/recovery.key', PASSWORD)).sessionId, sessionId);
    const plan = await verificationId(coordinator, sessionId);
    const written: Buffer[] = [];
    const result = await coordinator.exportCorrupt(sessionId, LIBRARY_ID, plan, (_name, bytes) => {
      written.push(Buffer.from(bytes));
      return Promise.resolve();
    });
    if (mode === 'decryptable') {
      assert.deepEqual(result, { exported: true, count: 1, unavailable: 0, error: null });
      assert.deepEqual(written, [world.corruptImage]);
    } else {
      assert.equal(result.exported, false);
      assert.equal(result.count, 0);
      assert.equal(result.unavailable, 1);
      assert.match(result.error ?? '', /0 decryptable images exported; 1 corrupt objects were unavailable/u);
      assert.deepEqual(written, []);
    }
    await coordinator.close();
  }
});

test('restore actions stay serialized while corrupt-image export rechecks its verification plan', async () => {
  const world = await remoteWorld();
  const runner = engineRunner(world.provider);
  const runVerify = runner.verify?.bind(runner);
  assert.ok(runVerify);
  let blockRecheck = false;
  let entered: (() => void) | undefined;
  const recheckStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () => ({
      run: runner.run.bind(runner),
      verify: async (request) => {
        const result = await runVerify(request);
        if (blockRecheck) {
          entered?.();
          await gate;
        }
        return result;
      },
    }),
    sessionId: () => 'session-export-serialized',
    progress: () => undefined,
  });
  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  const plan = await verificationId(coordinator, 'session-export-serialized');
  blockRecheck = true;
  const exporting = coordinator.exportCorrupt('session-export-serialized', LIBRARY_ID, plan, () => Promise.resolve());
  await recheckStarted;

  assert.match((await coordinator.discover('mock', '/recovery.key', PASSWORD)).error?.message ?? '', /already running/u);
  assert.match((await coordinator.run('session-export-serialized', LIBRARY_ID, plan, false)).error?.message ?? '', /already running/u);
  assert.match((await coordinator.verify('session-export-serialized', LIBRARY_ID)).error?.message ?? '', /already running/u);
  assert.match(
    (await coordinator.exportCorrupt('session-export-serialized', LIBRARY_ID, plan, () => Promise.resolve())).error ?? '',
    /already running/u,
  );

  assert.ok(release);
  release();
  assert.deepEqual(await exporting, { exported: true, count: 0, unavailable: 0, error: null });
  await coordinator.close();
});

test('corrupt-image export refuses stale, changed, and unavailable verification plans', async () => {
  for (const mode of ['stale-manifest', 'changed-scan', 'unavailable-scan'] as const) {
    const world = await remoteWorld();
    const runner = engineRunner(world.provider);
    const runVerify = runner.verify?.bind(runner);
    assert.ok(runVerify);
    let scans = 0;
    const coordinator = new RestoreCoordinator({
      readRecoveryKey: () => Promise.resolve(world.recoveryFile),
      sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
      createRunner: () => ({
        run: runner.run.bind(runner),
        verify: async (request) => {
          const current = await runVerify(request);
          scans += 1;
          if (mode === 'stale-manifest') return { ...current, sealedManifestSha256: 'f'.repeat(64) };
          if (scans > 1 && mode === 'changed-scan') return { ...current, objectSetSha256: 'f'.repeat(64) };
          if (scans > 1 && mode === 'unavailable-scan') throw new ProviderError('verification recheck unavailable', 'transient');
          return current;
        },
      }),
      sessionId: () => `session-export-${mode}`,
      progress: () => undefined,
    });
    const sessionId = `session-export-${mode}`;
    await coordinator.discover('mock', '/recovery.key', PASSWORD);
    const plan = await verificationId(coordinator, sessionId);
    const result = await coordinator.exportCorrupt(sessionId, LIBRARY_ID, plan, () => Promise.resolve());
    assert.equal(result.exported, false);
    assert.equal(result.count, 0);
    assert.equal(result.unavailable, 0);
    assert.match(result.error ?? '', mode === 'changed-scan' ? /changed after verification/u : /expired|unavailable/u);
    await coordinator.close();
  }
});

test('failed sidecars are reported unavailable and never exported as images', async () => {
  const world = await remoteWorld();
  const runner = engineRunner(world.provider);
  const runVerify = runner.verify?.bind(runner);
  assert.ok(runVerify);
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () => ({
      run: runner.run.bind(runner),
      verify: async (request) => {
        const current = await runVerify(request);
        return {
          ...current,
          missing: [{ path: 'sidecars/P1.xmp', kind: 'sidecar', photoId: 'P1', reason: 'failed-verification' }],
          missingCount: 1,
          corruptCount: 1,
        };
      },
    }),
    sessionId: () => 'session-export-sidecar',
    progress: () => undefined,
  });
  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  const plan = await verificationId(coordinator, 'session-export-sidecar');
  let writes = 0;
  const result = await coordinator.exportCorrupt('session-export-sidecar', LIBRARY_ID, plan, () => {
    writes += 1;
    return Promise.resolve();
  });
  assert.equal(writes, 0);
  assert.deepEqual(result, {
    exported: false,
    count: 0,
    unavailable: 1,
    error: '0 decryptable images exported; 1 corrupt objects were unavailable.',
  });
  await coordinator.close();
});

test('trash reports incomplete deletion honestly, retains the session, and invalidates the plan', async () => {
  const world = await remoteWorld();
  world.provider.delete = () => Promise.resolve();
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () => verifiedRunner(() => Promise.reject(new Error('unused'))),
    sessionId: () => 'session-trash',
    progress: () => undefined,
  });
  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  const plan = await verificationId(coordinator, 'session-trash');
  const failed = await coordinator.trash('session-trash', LIBRARY_ID, plan, 'Permanently Delete Backup');
  assert.equal(failed.trashed, false);
  assert.match(failed.error?.message ?? '', /objects remain/u);
  assert.equal(coordinator.providerFor('session-trash', LIBRARY_ID), world.provider);
  assert.equal(coordinator.verificationFor('session-trash', LIBRARY_ID, plan), null);
});

test('heal after restore moves corrupt objects aside and still activates', async () => {
  const world = await remoteWorld();
  await put(world.provider, 'blobs/bb/bad', Buffer.from('corrupt'));
  let activated = false;
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () =>
      verifiedRunner(() =>
        Promise.resolve({
          libraryId: LIBRARY_ID,
          generation: 2,
          photos: 1,
          resumed: false,
          missing: [{ path: 'blobs/bb/bad', kind: 'original', photoId: 'P1', reason: 'failed-verification' }],
        }),
      ),
    sessionId: () => 'session-heal',
    progress: () => undefined,
    activated: () => {
      activated = true;
    },
  });
  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  const run = await coordinator.run('session-heal', LIBRARY_ID, await verificationId(coordinator, 'session-heal'), false);
  assert.equal(run.error, null);
  assert.equal(activated, true);
  assert.deepEqual(await buffer(await world.provider.getStream('quarantine/gen-2/blobs/bb/bad')), Buffer.from('corrupt'));
  await coordinator.close();
});

test('heal failure after restore does not undo activation', async () => {
  const world = await remoteWorld();
  world.provider.put = () => Promise.reject(new Error('quota'));
  let activated = false;
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () =>
      verifiedRunner(() =>
        Promise.resolve({
          libraryId: LIBRARY_ID,
          generation: 2,
          photos: 1,
          resumed: false,
          missing: [{ path: 'blobs/bb/bad', kind: 'original', photoId: 'P1', reason: 'failed-verification' }],
        }),
      ),
    sessionId: () => 'session-heal-fail',
    progress: () => undefined,
    activated: () => {
      activated = true;
    },
  });
  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  const run = await coordinator.run('session-heal-fail', LIBRARY_ID, await verificationId(coordinator, 'session-heal-fail'), false);
  assert.equal(run.error, null);
  assert.equal(activated, true);
  await coordinator.close();
});

test('dismissVerification drops the plan and keeps the discovery session (#994)', async () => {
  const world = await remoteWorld();
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () => verifiedRunner(() => Promise.reject(new Error('unused'))),
    sessionId: () => 'session-dismiss',
    progress: () => undefined,
  });
  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  const plan = await verificationId(coordinator, 'session-dismiss');
  assert.ok(coordinator.status().verification);
  coordinator.dismissVerification();
  assert.equal(coordinator.status().verification, null);
  assert.equal(coordinator.status().sessionId, 'session-dismiss');
  assert.equal(coordinator.providerFor('session-dismiss', LIBRARY_ID), world.provider);
  assert.equal(coordinator.verificationFor('session-dismiss', LIBRARY_ID, plan), null);
  await coordinator.close();
});

test('trash reports success only after every scoped object is gone and clears the session', async () => {
  const world = await remoteWorld();
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () => verifiedRunner(() => Promise.reject(new Error('unused'))),
    sessionId: () => 'session-trash-success',
    progress: () => undefined,
  });
  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  const plan = await verificationId(coordinator, 'session-trash-success');
  const succeeded = await coordinator.trash('session-trash-success', LIBRARY_ID, plan, 'Permanently Delete Backup');
  assert.deepEqual(succeeded, { trashed: true, error: null });
  assert.equal(coordinator.providerFor('session-trash-success', LIBRARY_ID), null);
});

test('rediscovery invalidates verification plans from the prior session', async () => {
  const world = await remoteWorld();
  let sequence = 0;
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () => verifiedRunner(() => Promise.reject(new Error('unused'))),
    sessionId: () => `session-${String(++sequence)}`,
    progress: () => undefined,
  });
  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  const oldPlan = await verificationId(coordinator, 'session-1');
  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  assert.equal(coordinator.verificationFor('session-1', LIBRARY_ID, oldPlan), null);
  assert.match((await coordinator.run('session-2', LIBRARY_ID, oldPlan, false)).error?.message ?? '', /verification expired/u);
});

test('provider-wide connectivity failures remain global restore errors (#751)', async () => {
  const world = await remoteWorld();
  world.provider.getStream = () => Promise.reject(new ProviderError('provider is offline', 'transient'));
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () => ({ run: () => Promise.reject(new Error('unused')) }),
    sessionId: () => 'unused',
    progress: () => undefined,
  });

  const discovery = await coordinator.discover('icloud-drive', '/recovery.key', PASSWORD);
  assert.equal(discovery.sessionId, null);
  assert.deepEqual(discovery.libraries, []);
  assert.equal(discovery.error?.reason, 'offline');
});

test('status snapshot survives after the renderer unmounts and reports a running job', async () => {
  const world = await remoteWorld();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () =>
      verifiedRunner(async ({ signal }) => {
        await gate;
        assert.equal(signal?.aborted, false);
        return { libraryId: LIBRARY_ID, generation: 2, photos: 0, resumed: false, missing: [] };
      }),
    sessionId: () => 'session-status',
    progress: () => undefined,
  });
  assert.equal(coordinator.status().phase, 'idle');
  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  assert.equal(coordinator.status().phase, 'session');
  assert.equal(coordinator.status().sessionId, 'session-status');
  const plan = await verificationId(coordinator, 'session-status');
  const running = coordinator.run('session-status', LIBRARY_ID, plan, false);
  assert.equal(coordinator.status().phase, 'running');
  assert.equal(coordinator.status().libraryId, LIBRARY_ID);
  assert.match((await coordinator.discover('mock', '/recovery.key', PASSWORD)).error?.message ?? '', /already running/u);
  assert.ok(release);
  release();
  assert.equal((await running).error, null);
  assert.equal(coordinator.status().phase, 'complete');
  assert.equal(coordinator.status().lastResult?.libraryId, LIBRARY_ID);
  await coordinator.close();
});
