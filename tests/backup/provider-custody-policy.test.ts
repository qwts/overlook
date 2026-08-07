import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { DeterministicICloudDriveBridge } from '../../src/main/backup/icloud-drive/deterministic-bridge.js';
import type { StorageProvider } from '../../src/main/backup/provider.js';
import { ProviderRuntime, type ProviderRuntimeOptions } from '../../src/main/backup/provider-runtime.js';
import type { SafeStorageLike } from '../../src/main/crypto/keystore.js';

const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(plainText, 'utf8'),
  decryptString: (encrypted) => encrypted.toString('utf8'),
};

function runtime(overrides: Partial<ProviderRuntimeOptions>): ProviderRuntime {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'overlook-provider-custody-')), 'library');
  return new ProviderRuntime({
    dataDir: () => dataDir,
    safeStorage: () => safeStorage,
    openExternal: () => Promise.resolve(),
    setProviderId: () => undefined,
    providerId: () => null,
    isPackaged: false,
    harnessEnv: (name) => (name === 'OVERLOOK_E2E' ? '1' : undefined),
    pcloudEnabled: true,
    pcloudClientId: () => 'public-test-client',
    iCloudDriveBridge: new DeterministicICloudDriveBridge(),
    ...overrides,
  });
}

describe('provider custody-change policy (#732)', () => {
  test('identity-less pCloud custody fails closed without clearing authorization or selection (#927)', async () => {
    let providerId: string | null = 'pcloud';
    const r = runtime({
      providerId: () => providerId,
      setProviderId: (id) => {
        providerId = id;
      },
      custodyPreflight: (credential) => ({
        credential,
        totalItems: 0,
        totalBytes: 0,
        libraries: [],
      }),
      fetchImpl: () => Promise.reject(new Error('legacy fixture has no live identity')),
    });
    const record = {
      accessToken: 'legacy-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-08-06T00:00:00.000Z',
    } as const;
    r.tokenStore().save(record);
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-identity-less-custody'), fault: undefined });

    const result = await r.disconnect('pcloud');
    assert.equal(result.code, 'custody-unavailable');
    assert.deepEqual(r.tokenStore().load(), record);
    assert.equal(providerId, 'pcloud');
  });

  test('a repeated pCloud disconnect stays idempotent after the first request clears custody (#927)', async () => {
    let providerId: string | null = 'pcloud';
    let preflights = 0;
    const r = runtime({
      providerId: () => providerId,
      setProviderId: (id) => {
        providerId = id;
      },
      custodyPreflight: (credential) => {
        preflights += 1;
        return {
          credential,
          totalItems: 0,
          totalBytes: 0,
          libraries: [],
        };
      },
    });
    r.tokenStore().save({
      accessToken: 'repeat-disconnect-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-08-06T00:00:00.000Z',
      accountId: '927001',
      accountLabel: 'owner@pcloud.test',
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-repeat-disconnect'), fault: undefined });

    assert.deepEqual(await r.disconnect('pcloud'), { ok: true, reason: null });
    assert.deepEqual(await r.disconnect('pcloud'), { ok: true, reason: null });
    assert.equal(preflights, 1);
    assert.equal(r.tokenStore().load(), null);
    assert.equal(providerId, null);
  });

  test('an idempotent pCloud disconnect clears an unreadable authorization record (#927)', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'overlook-provider-custody-')), 'library');
    const authorizationPath = join(dataDir, 'pcloud-auth', 'pcloud-auth.bin');
    const r = runtime({ dataDir: () => dataDir });
    r.tokenStore().save({
      accessToken: 'unreadable-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-08-06T00:00:00.000Z',
      accountId: '927002',
      accountLabel: 'owner@pcloud.test',
    });
    writeFileSync(authorizationPath, 'not-json');

    assert.equal(r.tokenStore().load(), null);
    assert.deepEqual(await r.disconnect('pcloud'), { ok: true, reason: null });
    assert.equal(existsSync(authorizationPath), false);
  });

  test('an idempotent pCloud disconnect also clears unreadable legacy authorization bytes (#927 review)', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'overlook-provider-custody-')), 'library');
    const credentialDir = join(dataDir, 'provider-auth', 'pcloud');
    const legacyAuthorizationPath = join(dataDir, 'pcloud-auth.bin');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(legacyAuthorizationPath, 'not-json');
    const r = runtime({
      dataDir: () => dataDir,
      providerCredentialDir: () => credentialDir,
    });

    assert.equal(r.tokenStore().load(), null);
    assert.equal(existsSync(legacyAuthorizationPath), true, 'unreadable legacy bytes remain available for explicit cleanup');
    assert.deepEqual(await r.disconnect('pcloud'), { ok: true, reason: null });
    assert.equal(existsSync(legacyAuthorizationPath), false);
  });

  test('an idempotent pCloud disconnect reports an unreadable authorization cleanup failure (#927)', async () => {
    const r = runtime({});
    r.tokenStore().clear = () => {
      throw new Error('read-only credential directory');
    };

    assert.deepEqual(await r.disconnect('pcloud'), {
      ok: false,
      reason: 'Could not remove the pCloud authorization from this device. Check file access and try again.',
    });
  });

  test('disconnect and switch fail before credential mutation when custody requires restore-first', async () => {
    let providerId: string | null = 'pcloud';
    const preflights: { providerId: string; accountId: string }[] = [];
    const r = runtime({
      providerId: () => providerId,
      setProviderId: (id) => {
        providerId = id;
      },
      custodyPreflight: (credential) => {
        preflights.push(credential);
        return {
          credential,
          totalItems: 2,
          totalBytes: 200,
          libraries: [{ libraryId: 'library-a', name: 'Active', items: 2, bytes: 200, legacyUnbound: false }],
        };
      },
    });
    const record = {
      accessToken: 'retained-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-08-06T00:00:00.000Z',
      accountId: '1001',
      accountLabel: 'owner@pcloud.test',
    } as const;
    r.tokenStore().save(record);
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-custody-gate'), fault: undefined });

    const disconnected = await r.disconnect('pcloud');
    assert.equal(disconnected.code, 'custody-restore-required');
    assert.equal(disconnected.custody?.totalItems, 2);
    assert.deepEqual(r.tokenStore().load(), record);
    assert.equal(providerId, 'pcloud');

    const switched = await r.connect('mock');
    assert.equal(switched.code, 'custody-restore-required');
    assert.equal(providerId, 'pcloud');
    assert.deepEqual(preflights, [
      { providerId: 'pcloud', accountId: '1001' },
      { providerId: 'pcloud', accountId: '1001' },
    ]);
  });

  test('emergency removal marks the exact account provider-required before clearing credentials', async () => {
    let providerId: string | null = 'pcloud';
    const marked: { providerId: string; accountId: string }[] = [];
    const requirement = {
      providerId: 'pcloud',
      accountId: '1001',
      accountLabel: 'owner@pcloud.test',
      items: 2,
      bytes: 200,
    } as const;
    let credentialPresent = (): boolean => false;
    const r = runtime({
      providerId: () => providerId,
      setProviderId: (id) => {
        providerId = id;
      },
      markProviderRequired: (credential) => {
        assert.equal(credentialPresent(), true, 'database state commits before credential removal');
        assert.equal(providerId, 'pcloud');
        marked.push(credential);
      },
      providerRequirements: () => [requirement],
    });
    credentialPresent = () => r.tokenStore().load() !== null;
    r.tokenStore().save({
      accessToken: 'emergency-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-08-06T00:00:00.000Z',
      accountId: '1001',
      accountLabel: 'owner@pcloud.test',
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-emergency-removal'), fault: undefined });
    assert.deepEqual((await r.status('pcloud')).custodyRequirements, [requirement]);

    assert.deepEqual(await r.removeAuthorizationAnyway('pcloud'), { ok: true, reason: null });
    assert.deepEqual(marked, [{ providerId: 'pcloud', accountId: '1001' }]);
    assert.equal(r.tokenStore().load(), null);
    assert.equal(providerId, null);
  });
});

describe('provider reconnect custody result (#733)', () => {
  test('a failed custody proof keeps the new credential selected as a backup target', async () => {
    let providerId: string | null = null;
    let registryProvider: StorageProvider | undefined;
    let proofProvider: StorageProvider | undefined;
    let startupProofsPaused = false;
    let startupProofsResumed = false;
    const r = runtime({
      providerId: () => providerId,
      setProviderId: (id) => {
        providerId = id;
      },
      scopeProviderForOpenLibrary: (provider) => {
        registryProvider = provider;
        return new Proxy(provider, {});
      },
      verifyCustodyReconnect: (input) => {
        assert.equal(startupProofsPaused, true, 'explicit proof holds the startup-proof pause');
        proofProvider = input.provider;
        return Promise.resolve({ ok: false, reason: 'wrong-account' });
      },
      pauseCustodyReconnectProofs: () => {
        startupProofsPaused = true;
        return Promise.resolve(() => {
          startupProofsResumed = true;
        });
      },
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-reconnect-target'), fault: undefined });

    assert.deepEqual(await r.connect('mock'), {
      ok: false,
      reason: 'This provider account does not match the account holding this library’s cloud-only originals.',
      code: 'custody-wrong-account',
    });
    assert.equal(providerId, 'mock', 'the connection stands as the selected backup target');
    assert.notEqual(proofProvider, registryProvider, 'the proof receives the active-library provider scope');
    assert.equal((await r.status('mock')).connected, true);
    assert.equal(startupProofsResumed, true);
  });

  test('transient namespace proof failure is retryable without clearing selection', async () => {
    let providerId: string | null = null;
    const r = runtime({
      providerId: () => providerId,
      setProviderId: (id) => {
        providerId = id;
      },
      verifyCustodyReconnect: () => Promise.resolve({ ok: false, reason: 'unavailable' }),
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-reconnect-unavailable'), fault: undefined });

    const result = await r.connect('mock');
    assert.equal(result.code, 'custody-unavailable');
    assert.equal(result.retryable, true);
    assert.equal(providerId, 'mock');
  });

  test('library teardown aborts and drains an explicit reconnect proof', async () => {
    let proofStarted: (() => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => {
      proofStarted = resolve;
    });
    const r = runtime({
      verifyCustodyReconnect: (input) =>
        new Promise((resolve) => {
          observedSignal = input.signal;
          proofStarted?.();
          input.signal?.addEventListener('abort', () => resolve({ ok: false, reason: 'unavailable' }), { once: true });
        }),
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-reconnect-drain'), fault: undefined });

    const connect = r.connect('mock');
    await started;
    await r.drainReconnectVerifications();
    assert.equal(observedSignal?.aborted, true);
    assert.equal((await connect).code, 'custody-unavailable');
  });
});

test('emergency removal drains reconnect proof before changing custody authority', async () => {
  let providerId: string | null = null;
  let proofStarted: (() => void) | undefined;
  let proofSettled = false;
  let startupProofsPaused = false;
  let startupProofsResumed = false;
  const started = new Promise<void>((resolve) => {
    proofStarted = resolve;
  });
  const r = runtime({
    providerId: () => providerId,
    setProviderId: (id) => {
      providerId = id;
    },
    verifyCustodyReconnect: (input) =>
      new Promise((resolve) => {
        proofStarted?.();
        input.signal?.addEventListener(
          'abort',
          () => {
            proofSettled = true;
            resolve({ ok: false, reason: 'unavailable' });
          },
          { once: true },
        );
      }),
    markProviderRequired: () => {
      assert.equal(proofSettled, true, 'custody mutation follows reconnect proof settlement');
      assert.equal(startupProofsPaused, true, 'startup proofs pause before custody mutation');
    },
    pauseCustodyReconnectProofs: () => {
      startupProofsPaused = true;
      return Promise.resolve(() => {
        startupProofsResumed = true;
      });
    },
  });
  r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-reconnect-removal'), fault: undefined });

  const connect = r.connect('mock');
  await started;
  assert.deepEqual(await r.removeAuthorizationAnyway('mock'), { ok: true, reason: null });
  assert.equal((await connect).code, 'custody-unavailable');
  assert.equal(providerId, null);
  assert.equal(startupProofsResumed, true);
});

describe('emergency provider custody rollback (#732)', () => {
  test('failed emergency removal rolls back only when the same credential demonstrably remains', async () => {
    let rolledBack = 0;
    const r = runtime({
      providerId: () => 'pcloud',
      setProviderId: () => undefined,
      markProviderRequired: () => () => {
        rolledBack += 1;
      },
    });
    r.tokenStore().save({
      accessToken: 'retained-emergency-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-08-06T00:00:00.000Z',
      accountId: '1001',
      accountLabel: 'owner@pcloud.test',
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-emergency-rollback'), fault: undefined });

    assert.equal((await r.removeAuthorizationAnyway('pcloud')).ok, false);
    assert.equal(rolledBack, 1);
    assert.equal(r.tokenStore().load()?.accountId, '1001');
  });

  test('ordinary removal fails closed when a sealed library has no verified hint', async () => {
    const r = runtime({
      providerId: () => 'pcloud',
      custodyPreflight: (credential) => ({
        credential,
        totalItems: 0,
        totalBytes: 0,
        libraries: [],
        unverifiedLibraries: [{ libraryId: 'library-b', name: 'Archive' }],
      }),
    });
    r.tokenStore().save({
      accessToken: 'retained-unverified-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-08-06T00:00:00.000Z',
      accountId: '1001',
      accountLabel: 'owner@pcloud.test',
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-unverified-hint'), fault: undefined });

    const result = await r.disconnect('pcloud');
    assert.equal(result.code, 'custody-unavailable');
    assert.equal(result.custody?.unverifiedLibraries?.[0]?.libraryId, 'library-b');
    assert.equal(r.tokenStore().load()?.accountId, '1001');
  });
});
