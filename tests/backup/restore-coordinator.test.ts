import assert from 'node:assert/strict';
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
import { createEncryptStream } from '../../src/main/crypto/envelope.js';
import { KeyStore, type SafeStorageLike } from '../../src/main/crypto/keystore.js';
import { sealRecoveryKey } from '../../src/main/crypto/recovery.js';

const LIBRARY_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const GENERATED_AT = '2026-07-15T01:00:00.000Z';
const PASSWORD = 'correct horse battery staple';

const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => value.toString('utf8'),
};

async function put(provider: MockProvider, path: string, bytes: Buffer): Promise<void> {
  await provider.put(path, Readable.from([bytes]));
}

async function remoteWorld(libraryId = LIBRARY_ID) {
  const sourceDir = mkdtempSync(join(tmpdir(), 'restore-coordinator-source-'));
  const keys = KeyStore.open({ safeStorage, dataDir: sourceDir });
  const masterKey = keys.masterKeyBytes();
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'restore-coordinator-remote-')), libraryId });
  await put(
    provider,
    'recovery/bootstrap.ovrb',
    sealRecoveryBootstrap({ schema: 1, libraryId, generatedAt: GENERATED_AT, keys: keys.exportWrappedKeys() }, masterKey),
  );
  const manifest = buildBackupManifestV2({
    libraryId,
    generatedAt: GENERATED_AT,
    snapshot: {
      databaseSchema: 3,
      keyIds: [1],
      totals: { photos: 0, bytes: 0, albums: 0 },
      photos: [],
      albums: [],
    },
  });
  const sealed = await buffer(
    Readable.from([Buffer.from(JSON.stringify(manifest))]).pipe(createEncryptStream(keys.currentKey(), { photoId: 'manifest' })),
  );
  await put(provider, 'manifest/gen-2.ovlk', sealed);
  return { provider, masterKey, recoveryFile: sealRecoveryKey(masterKey, PASSWORD) };
}

test('restore coordinator discovers validated metadata and runs through an opaque session (#290)', async () => {
  const world = await remoteWorld();
  const progress = [];
  let activated = false;
  const runner: RestoreRunner = {
    run: ({ signal }) => {
      assert.equal(signal?.aborted, false);
      return Promise.resolve({ libraryId: LIBRARY_ID, generation: 2, photos: 0, resumed: false, missing: [] });
    },
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
  const run = await coordinator.run('session-1', LIBRARY_ID, false);
  assert.equal(run.error, null);
  assert.equal(run.result?.relaunching, true);
  assert.equal(activated, true);
  assert.equal(progress.length, 1);
  assert.equal((await coordinator.run('session-1', LIBRARY_ID, false)).error?.message.includes('expired'), true);
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

test('cancelled runs preserve the discovery session for resumable retry', async () => {
  const world = await remoteWorld();
  let attempt = 0;
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () => ({
      run: async ({ signal }) => {
        attempt += 1;
        if (attempt > 1) return { libraryId: LIBRARY_ID, generation: 2, photos: 0, resumed: true, missing: [] };
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
        throw new Error('unreachable');
      },
    }),
    sessionId: () => 'session-resume',
    progress: () => undefined,
  });
  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  const first = coordinator.run('session-resume', LIBRARY_ID, false);
  coordinator.cancel();
  assert.equal((await first).error?.reason, 'cancelled');
  assert.equal((await coordinator.run('session-resume', LIBRARY_ID, false)).result?.resumed, true);
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
  assert.equal((await coordinator.run('session-close', LIBRARY_ID, false)).error?.message.includes('expired'), true);
});

test("this Mac's stored master key discovers and restores without a recovery-key file (#741)", async () => {
  const world = await remoteWorld();
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.reject(new Error('the key file must not be read')),
    localMasterKey: () => Buffer.from(world.masterKey),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () => ({ run: () => Promise.resolve({ libraryId: LIBRARY_ID, generation: 2, photos: 0, resumed: false, missing: [] }) }),
    sessionId: () => 'session-local-key',
    progress: () => undefined,
  });
  const discovery = await coordinator.discoverFrom('mock', { kind: 'local-master' });
  assert.equal(discovery.error, null);
  assert.equal(discovery.sessionId, 'session-local-key');
  assert.equal(discovery.libraries[0]?.validation, 'valid');
  const run = await coordinator.run('session-local-key', LIBRARY_ID, false);
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
    createRunner: () => ({
      run: async ({ signal }) => {
        attempt += 1;
        if (attempt > 1) return { libraryId: LIBRARY_ID, generation: 2, photos: 0, resumed: false, missing: [] };
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
        throw new Error('unreachable');
      },
    }),
    sessionId: () => 'session-expire',
    progress: () => undefined,
  });
  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  const running = coordinator.run('session-expire', LIBRARY_ID, false);
  coordinator.expireSession();
  coordinator.cancel();
  assert.equal((await running).error?.reason, 'cancelled', 'the active run kept its session key');
  assert.equal(
    (await coordinator.run('session-expire', LIBRARY_ID, false)).result?.resumed,
    false,
    'the mid-run expire was a no-op: the cancelled session stayed retryable',
  );

  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  coordinator.expireSession();
  assert.equal(
    (await coordinator.run('session-expire', LIBRARY_ID, false)).error?.message.includes('expired'),
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
    createRunner: () => ({
      run: (request) => {
        requests.push(request);
        return Promise.resolve({ libraryId: LIBRARY_ID, generation: 2, photos: 0, resumed: false, missing: [] });
      },
    }),
    sessionId: () => 'session-custody',
    progress: () => undefined,
  });
  const discovery = await coordinator.discoverFrom('mock', { kind: 'local-master', custodyPassword: 'app pw' });
  assert.equal(discovery.error, null);
  await coordinator.run('session-custody', LIBRARY_ID, false);
  assert.equal(requests[0]?.custodyPassword, 'app pw');
});

test('recovery-key sessions never carry a custody password (#754)', async () => {
  const world = await remoteWorld();
  const requests: { custodyPassword?: string | undefined }[] = [];
  const coordinator = new RestoreCoordinator({
    readRecoveryKey: () => Promise.resolve(world.recoveryFile),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider: world.provider }]),
    createRunner: () => ({
      run: (request) => {
        requests.push(request);
        return Promise.resolve({ libraryId: LIBRARY_ID, generation: 2, photos: 0, resumed: false, missing: [] });
      },
    }),
    sessionId: () => 'session-rk',
    progress: () => undefined,
  });
  await coordinator.discover('mock', '/recovery.key', PASSWORD);
  await coordinator.run('session-rk', LIBRARY_ID, false);
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
  const run = await coordinator.run('session-wrong-local', LIBRARY_ID, false);
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
