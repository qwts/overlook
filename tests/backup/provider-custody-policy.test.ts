import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { DeterministicICloudDriveBridge } from '../../src/main/backup/icloud-drive/deterministic-bridge.js';
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
