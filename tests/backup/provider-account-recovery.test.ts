import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeterministicICloudDriveBridge } from '../../src/main/backup/icloud-drive/deterministic-bridge.js';
import { ProviderRuntime, type ProviderRuntimeOptions } from '../../src/main/backup/provider-runtime.js';
import type { SafeStorageLike } from '../../src/main/crypto/keystore.js';

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(plainText, 'utf8'),
  decryptString: (encrypted) => encrypted.toString('utf8'),
};

function runtime(overrides: Partial<ProviderRuntimeOptions>): ProviderRuntime {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'overlook-provider-account-recovery-')), 'library');
  return new ProviderRuntime({
    dataDir: () => dataDir,
    safeStorage: () => fakeSafeStorage,
    openExternal: () => Promise.resolve(),
    setProviderId: () => undefined,
    providerId: () => null,
    isPackaged: false,
    harnessEnv: () => undefined,
    pcloudEnabled: true,
    pcloudClientId: () => 'public-test-client',
    iCloudDriveBridge: new DeterministicICloudDriveBridge(),
    ...overrides,
  });
}

describe('provider account authentication recovery (#730)', () => {
  test('revoked legacy pCloud authority is cleared and Connect falls back to OAuth', async () => {
    let browserOpens = 0;
    const providerRuntime = runtime({
      fetchImpl: () => Promise.resolve(Response.json({ result: 2000, error: 'invalid access token' })),
      openExternal: () => {
        browserOpens += 1;
        return Promise.reject(new Error('scripted browser stop'));
      },
    });
    providerRuntime.tokenStore().save({
      accessToken: 'revoked-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-08-06T00:00:00.000Z',
    });
    providerRuntime.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-pcloud-reauth'), fault: undefined });

    const result = await providerRuntime.connect('pcloud');

    assert.equal(browserOpens, 1);
    assert.equal(providerRuntime.tokenStore().load(), null, 'revoked credential is removed before OAuth');
    assert.match(result.reason ?? '', /scripted browser stop/u);
  });

  test('revoked legacy Google Drive authority is cleared and Connect falls back to OAuth', async () => {
    let browserOpens = 0;
    const providerRuntime = runtime({
      googleDriveClientId: () => 'desktop.apps.googleusercontent.com',
      fetchImpl: () => Promise.resolve(Response.json({ error: 'invalid_grant', error_description: 'revoked' }, { status: 400 })),
      openExternal: () => {
        browserOpens += 1;
        return Promise.reject(new Error('scripted browser stop'));
      },
    });
    providerRuntime.googleTokenStore().save({
      clientId: 'desktop.apps.googleusercontent.com',
      refreshToken: 'revoked-refresh-token',
      connectedAt: '2026-08-06T00:00:00.000Z',
    });
    providerRuntime.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-google-reauth'), fault: undefined });

    const result = await providerRuntime.connect('google-drive');

    assert.equal(browserOpens, 1);
    assert.equal(providerRuntime.googleTokenStore().load(), null, 'revoked credential is removed before OAuth');
    assert.match(result.reason ?? '', /scripted browser stop/u);
  });
});
