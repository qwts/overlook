import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeterministicICloudDriveBridge } from '../../src/main/backup/icloud-drive/deterministic-bridge.js';
import { ICloudDriveAuthorityStore } from '../../src/main/backup/icloud-drive/authority-store.js';
import { ProviderRuntime } from '../../src/main/backup/provider-runtime.js';
import type { SafeStorageLike } from '../../src/main/crypto/keystore.js';

const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(plainText, 'utf8'),
  decryptString: (encrypted) => encrypted.toString('utf8'),
};

test('a failed replacement-account identity probe preserves the pinned iCloud authority (#730)', async () => {
  const bridge = new DeterministicICloudDriveBridge();
  const root = mkdtempSync(join(tmpdir(), 'overlook-runtime-icloud-replacement-'));
  const credentialDir = join(root, 'provider-auth', 'icloud-drive');
  const authorityStore = new ICloudDriveAuthorityStore(safeStorage, credentialDir);
  authorityStore.save({ accountId: '0123456789abcdef', accountLabel: 'Original iCloud account' });
  bridge.changeAccount('fedcba9876543210');
  const liveStatus = bridge.status.bind(bridge);
  let statusCalls = 0;
  bridge.status = () => {
    statusCalls += 1;
    return statusCalls >= 4 ? new Promise(() => undefined) : liveStatus();
  };
  const runtime = new ProviderRuntime({
    dataDir: () => join(root, 'library'),
    providerCredentialDir: (id) => join(root, 'provider-auth', id),
    safeStorage: () => safeStorage,
    openExternal: () => Promise.resolve(),
    setProviderId: () => assert.fail('a failed identity probe must not activate the replacement account'),
    providerId: () => 'icloud-drive',
    isPackaged: true,
    harnessEnv: () => undefined,
    pcloudEnabled: false,
    pcloudClientId: () => null,
    iCloudDriveBridge: bridge,
    statusTimeoutMs: 5,
  });
  runtime.buildProvider({ mockRootDir: join(root, 'mock'), fault: undefined });

  assert.deepEqual(await runtime.connect('icloud-drive'), {
    ok: false,
    reason: 'iCloud Drive could not verify the account identity. Check the connection and try again.',
    code: 'identity-unavailable',
    retryable: true,
  });
  bridge.status = liveStatus;
  assert.deepEqual(authorityStore.loadRecord(), {
    accountId: '0123456789abcdef',
    accountLabel: 'Original iCloud account',
  });
  assert.equal(await runtime.provider('icloud-drive')?.authState(), 'expired', 'the replacement account remains unauthorized');
});
