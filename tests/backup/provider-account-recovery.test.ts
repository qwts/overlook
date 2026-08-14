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

test('same-provider account changes commit identity before switch-guard mutations (#730)', async () => {
  let providerId: string | null = 'pcloud';
  let guardCalls = 0;
  const providerRuntime = runtime({
    providerId: () => providerId,
    setProviderId: (id) => {
      providerId = id;
    },
    fetchImpl: () => Promise.resolve(Response.json({ result: 0, userid: 73002, email: 'replacement@pcloud.test' })),
    switchGuard: () => {
      guardCalls += 1;
      return Promise.resolve({ ok: false, reason: 'cloud-only originals remain in the original account' });
    },
  });
  providerRuntime.tokenStore().save({
    accessToken: 'account-changed-token',
    apiHost: 'api.pcloud.com',
    connectedAt: '2026-08-06T00:00:00.000Z',
    accountId: '73001',
    accountLabel: 'original@pcloud.test',
  });
  providerRuntime.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-pcloud-account-change'), fault: undefined });

  assert.deepEqual(await providerRuntime.connect('pcloud'), {
    ok: false,
    reason: 'cloud-only originals remain in the original account',
  });
  assert.equal(guardCalls, 1);
  assert.equal(providerId, null, 'a rejected account replacement is no longer selected');
  assert.equal(providerRuntime.activeId(), null);
  assert.deepEqual(providerRuntime.tokenStore().load(), {
    accessToken: 'account-changed-token',
    apiHost: 'api.pcloud.com',
    connectedAt: '2026-08-06T00:00:00.000Z',
    accountId: '73002',
    accountLabel: 'replacement@pcloud.test',
  });
});

test('an account change during reconnect refreshes the later disconnect preflight subject (#733)', async () => {
  let providerId: string | null = 'pcloud';
  let preflightAccount: string | undefined;
  const providerRuntime = runtime({
    providerId: () => providerId,
    setProviderId: (id) => {
      providerId = id;
    },
    fetchImpl: () => Promise.resolve(Response.json({ result: 0, userid: 73001, email: 'original@pcloud.test' })),
    verifyCustodyReconnect: () =>
      Promise.resolve({
        ok: false,
        reason: 'wrong-account',
        replacementIdentity: { accountId: '73002', accountLabel: 'replacement@pcloud.test' },
      }),
    custodyPreflight: (credential) => {
      preflightAccount = credential.accountId;
      return {
        credential,
        totalItems: 1,
        totalBytes: 1,
        libraries: [{ libraryId: 'library-a', name: 'Active', items: 1, bytes: 1, legacyUnbound: false }],
      };
    },
  });
  providerRuntime.tokenStore().save({
    accessToken: 'mid-proof-change-token',
    apiHost: 'api.pcloud.com',
    connectedAt: '2026-08-06T00:00:00.000Z',
    accountId: '73001',
    accountLabel: 'original@pcloud.test',
  });
  providerRuntime.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-mid-proof-change'), fault: undefined });

  assert.equal((await providerRuntime.connect('pcloud')).code, 'custody-wrong-account');
  assert.equal(providerRuntime.tokenStore().load()?.accountId, '73002');
  assert.equal((await providerRuntime.disconnect('pcloud')).code, 'custody-restore-required');
  assert.equal(preflightAccount, '73002');
  assert.equal(providerId, null, 'the replacement account must pass the switch guard on retry');
});

describe('provider account authentication recovery (#730)', () => {
  test('revoked current pCloud authority is cleared and Connect falls back to OAuth', async () => {
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
      accountId: '73001',
      accountLabel: 'owner@pcloud.test',
    });
    providerRuntime.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-pcloud-reauth'), fault: undefined });

    const result = await providerRuntime.connect('pcloud');

    assert.equal(browserOpens, 1);
    assert.equal(providerRuntime.tokenStore().load(), null, 'revoked credential is removed before OAuth');
    assert.match(result.reason ?? '', /scripted browser stop/u);
  });

  test('revoked current Google Drive authority is cleared and Connect falls back to OAuth', async () => {
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
      accountId: 'permission-1',
      accountLabel: 'owner@google.test',
    });
    providerRuntime.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-google-reauth'), fault: undefined });

    const result = await providerRuntime.connect('google-drive');

    assert.equal(browserOpens, 1);
    assert.equal(providerRuntime.googleTokenStore().load(), null, 'revoked credential is removed before OAuth');
    assert.match(result.reason ?? '', /scripted browser stop/u);
  });
});

describe('provider account recovery failures (#730)', () => {
  test('Google identity deadline aborts a stalled refresh so the next Connect starts a new request', async () => {
    let refreshes = 0;
    let aborts = 0;
    const providerRuntime = runtime({
      googleDriveClientId: () => 'desktop.apps.googleusercontent.com',
      statusTimeoutMs: 15,
      fetchImpl: (_input, init) => {
        refreshes += 1;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const abort = (): void => {
            aborts += 1;
            reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
          };
          if (signal?.aborted === true) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      },
    });
    providerRuntime.googleTokenStore().save({
      clientId: 'desktop.apps.googleusercontent.com',
      refreshToken: 'stalled-refresh-token',
      connectedAt: '2026-08-06T00:00:00.000Z',
      accountId: 'permission-1',
      accountLabel: 'owner@google.test',
    });
    providerRuntime.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-google-timeout'), fault: undefined });

    assert.equal((await providerRuntime.connect('google-drive')).code, 'identity-unavailable');
    assert.equal((await providerRuntime.connect('google-drive')).code, 'identity-unavailable');
    assert.equal(refreshes, 2, 'the aborted refresh is not reused');
    assert.equal(aborts, 2);
    assert.notEqual(providerRuntime.googleTokenStore().load(), null, 'timeouts retain credential custody');
  });

  test('iCloud authority persistence failure reports the Keychain recovery path', async () => {
    const providerRuntime = runtime({
      safeStorage: () => ({ ...fakeSafeStorage, isEncryptionAvailable: () => false }),
    });
    providerRuntime.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-icloud-keychain'), fault: undefined });

    assert.deepEqual(await providerRuntime.connect('icloud-drive'), {
      ok: false,
      reason: 'Could not securely save this iCloud account authority. Check Keychain access and try again.',
    });
  });
});
