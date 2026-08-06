import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderRuntime, type ProviderRuntimeOptions } from '../../src/main/backup/provider-runtime.js';
import { GoogleDrivePathStore } from '../../src/main/backup/google-drive/path-store.js';
import { PCloudTokenStore } from '../../src/main/backup/pcloud/token-store.js';
import type { SafeStorageLike } from '../../src/main/crypto/keystore.js';
import { DeterministicICloudDriveBridge } from '../../src/main/backup/icloud-drive/deterministic-bridge.js';
import { ICloudDriveAuthorityStore } from '../../src/main/backup/icloud-drive/authority-store.js';

// #256: provider-selection policy — production vs explicit E2E targets, the
// stale-mock correction, and the persistent library id.

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(plainText, 'utf8'),
  decryptString: (encrypted) => encrypted.toString('utf8'),
};

function runtime(overrides: Partial<ProviderRuntimeOptions> = {}) {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'overlook-runtime-')), 'library');
  return {
    dataDir,
    runtime: new ProviderRuntime({
      dataDir: () => dataDir,
      safeStorage: () => fakeSafeStorage,
      openExternal: () => Promise.resolve(),
      setProviderId: () => undefined,
      providerId: () => null,
      isPackaged: false,
      harnessEnv: (name) => (name === 'OVERLOOK_E2E' ? '1' : undefined),
      pcloudEnabled: true,
      pcloudClientId: () => 'public-test-client',
      iCloudDriveBridge: new DeterministicICloudDriveBridge(),
      ...overrides,
    }),
  };
}

describe('provider runtime policy (#256)', () => {
  test('libraryId mints one ULID and persists it — restarts reuse the same remote home', () => {
    const { runtime: r, dataDir } = runtime();
    const first = r.libraryId();
    assert.match(first, /^[0-9A-HJKMNP-TV-Z]{26}$/u, 'Crockford ULID shape');
    assert.equal(r.libraryId(), first);
    assert.equal(readFileSync(join(dataDir, 'library-id'), 'utf8').trim(), first);
    assert.equal(
      new ProviderRuntime({ ...baseOptions(), dataDir: () => dataDir }).libraryId(),
      first,
      'a fresh instance (restart) reads the same id',
    );
  });

  test('a corrupted library-id record is replaced, never used as a remote home (PR #260 review)', () => {
    const { runtime: r, dataDir } = runtime();
    const original = r.libraryId();
    for (const bad of ['', 'short', `${original}\nTRAILING-JUNK-MAKING-IT-LONG`, 'lowercase0123456789abcdef0']) {
      writeFileSync(join(dataDir, 'library-id'), bad);
      const replacement = r.libraryId();
      assert.match(replacement, /^[0-9A-HJKMNP-TV-Z]{26}$/u);
      assert.equal(readFileSync(join(dataDir, 'library-id'), 'utf8').trim(), replacement, 'the fresh id is persisted');
    }
  });

  test('defaultTarget: ordinary dev and packaged → pcloud; explicit E2E → mock', () => {
    assert.equal(runtime().runtime.defaultTarget(), 'mock');
    assert.equal(runtime({ harnessEnv: () => undefined }).runtime.defaultTarget(), 'pcloud');
    assert.equal(runtime({ isPackaged: true }).runtime.defaultTarget(), 'pcloud');
    assert.equal(
      runtime({ harnessEnv: (name) => (name === 'OVERLOOK_PROVIDER' ? 'pcloud' : undefined) }).runtime.defaultTarget(),
      'pcloud',
    );
    assert.equal(
      runtime({ harnessEnv: (name) => (name === 'OVERLOOK_PROVIDER' ? 'garbage' : undefined) }).runtime.defaultTarget(),
      'pcloud',
    );
    assert.equal(
      runtime({
        harnessEnv: (name) => (name === 'OVERLOOK_PROVIDER' ? 'google-drive' : undefined),
        googleDriveClientId: () => 'desktop.apps.googleusercontent.com',
      }).runtime.defaultTarget(),
      'google-drive',
    );
  });

  test("activeId: only explicit E2E accepts 'mock' authority", () => {
    assert.equal(runtime({ providerId: () => 'mock', isPackaged: true }).runtime.activeId(), null);
    assert.equal(runtime({ providerId: () => 'mock' }).runtime.activeId(), 'mock');
    assert.equal(runtime({ providerId: () => 'mock', harnessEnv: () => undefined }).runtime.activeId(), null);
    const pcloud = runtime({ providerId: () => 'pcloud', isPackaged: true });
    assert.equal(pcloud.runtime.activeId(), null, 'a token without a named account is not active');
    pcloud.runtime.tokenStore().save({
      accessToken: 'sealed-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-08-06T00:00:00.000Z',
      accountId: '1001',
      accountLabel: 'owner@pcloud.test',
    });
    assert.equal(pcloud.runtime.activeId(), 'pcloud');
    assert.equal(runtime({ providerId: () => 'icloud-drive', isPackaged: true }).runtime.activeId(), null);
    assert.equal(runtime({ providerId: () => 'google-drive' }).runtime.activeId(), null, 'an unconfigured Drive build is disconnected');
    const google = runtime({ providerId: () => 'google-drive', googleDriveClientId: () => 'desktop.apps.googleusercontent.com' });
    assert.equal(google.runtime.activeId(), null, 'a refresh token without a named account is not active');
    google.runtime.googleTokenStore().save({
      clientId: 'desktop.apps.googleusercontent.com',
      refreshToken: 'refresh-token',
      connectedAt: '2026-08-06T00:00:00.000Z',
      accountId: 'permission-1',
      accountLabel: 'owner@google.test',
    });
    assert.equal(google.runtime.activeId(), 'google-drive');
    assert.equal(runtime({ providerId: () => null }).runtime.activeId(), null);
    const { runtime: unavailable } = runtime({ providerId: () => 'missing-provider' });
    unavailable.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-mock'), fault: undefined });
    assert.equal(unavailable.activeId(), null, 'an unavailable id never falls through to another remote authority');
  });

  test('ordinary development exposes only production providers and no false connected mock', async () => {
    const { runtime: r } = runtime({ providerId: () => 'mock', harnessEnv: () => undefined });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-unused-mock'), fault: undefined });

    assert.equal(r.activeId(), null);
    assert.equal(r.defaultTarget(), 'pcloud');
    assert.deepEqual(
      (await r.descriptors()).map(({ id }) => id),
      ['pcloud', 'google-drive', 'icloud-drive'],
    );
  });

  test('disabled pCloud is absent, cannot activate, and does not clear existing custody', async () => {
    const { runtime: r } = runtime({
      pcloudEnabled: false,
      providerId: () => 'pcloud',
      harnessEnv: () => undefined,
    });
    r.tokenStore().save({
      accessToken: 'sealed-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-07-23T00:00:00.000Z',
      accountId: '1001',
      accountLabel: 'owner@pcloud.test',
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-unused-mock'), fault: undefined });

    assert.equal(r.activeId(), null);
    assert.equal(r.defaultTarget(), 'icloud-drive');
    assert.equal(r.provider('pcloud'), undefined);
    assert.deepEqual(
      (await r.descriptors()).map(({ id }) => id),
      ['google-drive', 'icloud-drive'],
    );
    assert.equal((await r.connect('pcloud')).ok, false);
    assert.notEqual(r.tokenStore().load(), null, 'feature disablement preserves credential custody');
  });

  test('provider-addressed connect flips selection only after success', async () => {
    let flipped: string | null = null;
    const { runtime: r } = runtime({
      setProviderId: (id) => {
        flipped = id;
      },
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-mock'), fault: undefined });
    assert.equal((await r.connect('missing-provider')).ok, false);
    assert.equal(flipped, null, 'an unavailable provider never changes remote authority');
    assert.equal((await r.connect('mock')).ok, true);
    assert.equal(flipped, 'mock');
  });

  test('a refused switch guard keeps the previous selection and the fresh credential (#741)', async () => {
    let providerId: string | null = 'mock';
    const guarded: string[] = [];
    const { runtime: r } = runtime({
      providerId: () => providerId,
      setProviderId: (id) => {
        providerId = id;
      },
      switchGuard: (target) => {
        guarded.push(target.providerId);
        return Promise.resolve({ ok: false, reason: '2 cloud-only originals are not in this provider.' });
      },
    });
    r.tokenStore().save({
      accessToken: 'sealed-pcloud-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-07-22T00:00:00.000Z',
      accountId: '1001',
      accountLabel: 'owner@pcloud.test',
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-guard-refuse'), fault: undefined });

    const result = await r.connect('pcloud');
    assert.deepEqual(result, { ok: false, reason: '2 cloud-only originals are not in this provider.' });
    assert.deepEqual(guarded, ['pcloud'], 'the guard saw the activation target');
    assert.equal(providerId, 'mock', 'the previous provider stays active');
    assert.notEqual(r.tokenStore().load(), null, 'the sealed credential survives the refusal');
  });

  test('an approved switch guard lets sealed authority reactivate without OAuth (#741)', async () => {
    let providerId: string | null = 'mock';
    const { runtime: r } = runtime({
      providerId: () => providerId,
      setProviderId: (id) => {
        providerId = id;
      },
      switchGuard: () => Promise.resolve({ ok: true, reason: null }),
    });
    r.tokenStore().save({
      accessToken: 'sealed-pcloud-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-07-22T00:00:00.000Z',
      accountId: '1001',
      accountLabel: 'owner@pcloud.test',
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-guard-approve'), fault: undefined });

    assert.deepEqual(await r.connect('pcloud'), { ok: true, reason: null });
    assert.equal(providerId, 'pcloud');
  });

  test('re-activating the CURRENT provider never consults the switch guard (#741)', async () => {
    let guardCalls = 0;
    const { runtime: r } = runtime({
      providerId: () => 'mock',
      switchGuard: () => {
        guardCalls += 1;
        return Promise.resolve({ ok: false, reason: 'must not be consulted' });
      },
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-guard-same'), fault: undefined });

    assert.deepEqual(await r.connect('mock'), { ok: true, reason: null });
    assert.equal(guardCalls, 0);
  });

  test('connection status never waits for storage inventory or quota (#721)', async () => {
    const { runtime: r } = runtime({ providerId: () => 'mock' });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-status-fast'), fault: undefined });
    const provider = r.provider('mock');
    assert.ok(provider);
    let inventoryCalls = 0;
    let quotaCalls = 0;
    provider.listLibraries = () => {
      inventoryCalls += 1;
      return new Promise<never>(() => undefined);
    };
    provider.quota = () => {
      quotaCalls += 1;
      return new Promise<never>(() => undefined);
    };

    const status = await Promise.race([
      r.status('mock'),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
    ]);
    assert.notEqual(status, 'timed-out');
    assert.deepEqual(status, {
      provider: (await r.descriptors()).find(({ id }) => id === 'mock'),
      connected: true,
      accountLabel: 'Mock account',
    });
    assert.equal(inventoryCalls, 0);
    assert.equal(quotaCalls, 0);
  });

  test('storage status calls only the provider-native quota API (#721)', async () => {
    const { runtime: r } = runtime({ providerId: () => 'mock' });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-native-quota'), fault: undefined });
    const provider = r.provider('mock');
    assert.ok(provider);
    provider.listLibraries = () => {
      throw new Error('inventory measurement must not run');
    };
    provider.list = () => {
      throw new Error('recursive inventory measurement must not run');
    };
    let quotaCalls = 0;
    provider.quota = () => {
      quotaCalls += 1;
      return Promise.resolve({ usedBytes: 256, totalBytes: 1024 });
    };

    const capacity = await r.storage('mock');

    assert.equal(quotaCalls, 1);
    assert.deepEqual(capacity, { capacity: { usedBytes: 256, totalBytes: 1024 }, capacityRoute: 'none' });
  });

  test('connect reactivates existing sealed authority without another OAuth flow (#721)', async () => {
    let providerId: string | null = 'google-drive';
    const { runtime: r } = runtime({
      providerId: () => providerId,
      setProviderId: (id) => {
        providerId = id;
      },
    });
    r.tokenStore().save({
      accessToken: 'existing-pcloud-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-07-22T00:00:00.000Z',
      accountId: '1001',
      accountLabel: 'owner@pcloud.test',
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-reactivate'), fault: undefined });

    assert.deepEqual(await r.connect('pcloud'), { ok: true, reason: null });
    assert.equal(providerId, 'pcloud');
  });

  test('Google Drive reactivates its sealed refresh token without opening OAuth (#721)', async () => {
    let providerId: string | null = 'pcloud';
    let browserOpens = 0;
    const { runtime: r } = runtime({
      providerId: () => providerId,
      setProviderId: (id) => {
        providerId = id;
      },
      googleDriveClientId: () => 'desktop.apps.googleusercontent.com',
      openExternal: () => {
        browserOpens += 1;
        return Promise.resolve();
      },
    });
    r.googleTokenStore().save({
      clientId: 'desktop.apps.googleusercontent.com',
      refreshToken: 'existing-google-refresh-token',
      connectedAt: '2026-07-22T00:00:00.000Z',
      accountId: 'permission-1',
      accountLabel: 'owner@google.test',
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-google-reactivate'), fault: undefined });

    assert.deepEqual(await r.connect('google-drive'), { ok: true, reason: null });
    assert.equal(providerId, 'google-drive');
    assert.equal(browserOpens, 0);
  });

  test('capacity bounds a stalled native quota call without changing authority (#721)', async () => {
    const { runtime: r } = runtime({ providerId: () => 'mock', storageTimeoutMs: 15 });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-capacity-stall'), fault: undefined });
    const provider = r.provider('mock');
    assert.ok(provider);
    provider.listLibraries = () => {
      throw new Error('inventory measurement must not run');
    };
    provider.list = () => {
      throw new Error('recursive inventory measurement must not run');
    };
    provider.quota = (signal) =>
      new Promise<never>((_resolve, reject) => {
        const fail = (): void => reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
        if (signal?.aborted === true) fail();
        else signal?.addEventListener('abort', fail, { once: true });
      });

    const first = r.storage('mock');
    assert.equal(r.storage('mock'), first, 'concurrent capacity requests share one native quota call');
    assert.deepEqual(await first, { capacity: null, capacityRoute: 'none' });
    assert.equal((await r.status('mock')).connected, true);
    assert.equal(r.activeId(), 'mock');
  });

  test('pCloud disconnect verifies custody and persisted selection before reporting success', async () => {
    let providerId: string | null = 'pcloud';
    const { runtime: r } = runtime({
      providerId: () => providerId,
      setProviderId: (id) => {
        providerId = id;
      },
    });
    const record = {
      accessToken: 'disconnect-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-07-18T00:00:00.000Z',
    } as const;
    r.tokenStore().save(record);
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-mock'), fault: undefined });

    assert.deepEqual(await Promise.resolve(r.disconnect('pcloud')), { ok: true, reason: null });
    assert.equal(r.tokenStore().load(), null);
    assert.equal(providerId, null);
  });

  test('pCloud disconnect restores custody when provider selection does not persist', async () => {
    const { runtime: r } = runtime({
      providerId: () => 'pcloud',
      setProviderId: () => undefined,
    });
    const record = {
      accessToken: 'rollback-token',
      apiHost: 'eapi.pcloud.com',
      connectedAt: '2026-07-18T00:00:00.000Z',
    } as const;
    r.tokenStore().save(record);
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-mock'), fault: undefined });

    const result = await Promise.resolve(r.disconnect('pcloud'));
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /save the disconnected state/u);
    assert.deepEqual(r.tokenStore().load(), record, 'a failed settings write cannot silently discard working credentials');
  });

  test('pCloud disconnect reports credential-removal failure without changing provider selection', async () => {
    let providerId: string | null = 'pcloud';
    const { runtime: r } = runtime({
      providerId: () => providerId,
      setProviderId: (id) => {
        providerId = id;
      },
    });
    const store = r.tokenStore();
    store.save({
      accessToken: 'retained-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-07-18T00:00:00.000Z',
    });
    store.clear = () => {
      throw new Error('injected custody failure');
    };
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-mock'), fault: undefined });

    const result = await Promise.resolve(r.disconnect('pcloud'));
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /remove the pCloud authorization/u);
    assert.equal(providerId, 'pcloud');
  });

  test('concurrent pCloud disconnect requests share one transaction', async () => {
    let providerId: string | null = 'pcloud';
    const { runtime: r } = runtime({
      providerId: () => providerId,
      setProviderId: (id) => {
        providerId = id;
      },
    });
    r.tokenStore().save({
      accessToken: 'single-flight-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-07-18T00:00:00.000Z',
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-mock'), fault: undefined });

    const first = r.disconnect('pcloud');
    const repeated = r.disconnect('pcloud');
    assert.equal(repeated, first);
    await Promise.resolve(first);
  });

  test('descriptors expose capabilities and switching is blocked during active work', async () => {
    let active = true;
    const { runtime: r } = runtime({ isWorkActive: () => active });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-mock'), fault: undefined });
    assert.deepEqual(
      (await r.descriptors()).map(({ id, capabilities }) => ({ id, quota: capabilities.quota })),
      [
        { id: 'pcloud', quota: 'known' },
        { id: 'google-drive', quota: 'known' },
        { id: 'icloud-drive', quota: 'unknown' },
        { id: 'mock', quota: 'known' },
      ],
    );
    const drive = (await r.descriptors()).find(({ id }) => id === 'google-drive');
    assert.deepEqual(
      { available: drive?.available, reason: drive?.unavailableReason },
      { available: false, reason: 'Google Drive OAuth is not configured in this build.' },
    );
    assert.equal((await r.connect('google-drive')).ok, false);
    assert.equal((await r.connect('mock')).ok, false);
    assert.equal((await r.disconnect('mock')).ok, false);
    active = false;
    assert.equal((await r.connect('mock')).ok, true);
  });

  test('iCloud availability, account replacement, reconnect, and library rebinding fail closed', async () => {
    const bridge = new DeterministicICloudDriveBridge();
    let providerId: string | null = null;
    const root = mkdtempSync(join(tmpdir(), 'overlook-runtime-icloud-authority-'));
    const options = {
      dataDir: () => join(root, 'library'),
      providerCredentialDir: (id: string) => join(root, 'provider-auth', id),
      iCloudDriveBridge: bridge,
      providerId: () => providerId,
      setProviderId: (id: string | null) => {
        providerId = id;
      },
    };
    const { runtime: r } = runtime({
      ...options,
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-icloud'), fault: undefined });
    assert.deepEqual(await r.connect('icloud-drive'), { ok: true, reason: null });
    assert.equal(providerId, 'icloud-drive');
    assert.equal((await r.status('icloud-drive')).connected, true);

    providerId = 'pcloud';
    assert.deepEqual(await r.connect('icloud-drive'), { ok: true, reason: null }, 'sealed iCloud authority reactivates the provider');
    assert.equal(providerId, 'icloud-drive');

    const restarted = runtime(options).runtime;
    restarted.buildProvider({ mockRootDir: join(root, 'restart-mock'), fault: undefined });
    assert.equal(restarted.activeId(), 'icloud-drive', 'restart restores the sealed account authority');
    assert.equal((await restarted.status('icloud-drive')).connected, true);

    bridge.changeAccount();
    const afterAccountSwitch = runtime(options).runtime;
    afterAccountSwitch.buildProvider({ mockRootDir: join(root, 'switched-account-mock'), fault: undefined });
    assert.equal(
      (await afterAccountSwitch.status('icloud-drive')).connected,
      false,
      'an OS-account replacement while Overlook is closed cannot inherit the old authority',
    );
    assert.deepEqual(await r.connect('icloud-drive'), { ok: true, reason: null }, 'explicit reconnect pins the replacement account');
    assert.equal((await r.status('icloud-drive')).connected, true);

    const previous = r.provider('icloud-drive');
    r.resetLibraryBinding();
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-icloud'), fault: undefined, libraryId: 'LIBRARY_B' });
    assert.notEqual(r.provider('icloud-drive'), previous);
    assert.equal((await r.status('icloud-drive')).connected, true, 'a library rebind accepts the current account without stale authority');
  });

  test('capacity route opens System Settings for iCloud only (#684)', async () => {
    const opened: string[] = [];
    const { runtime: r } = runtime({
      openExternal: (url: string) => {
        opened.push(url);
        return Promise.resolve();
      },
    });
    assert.deepEqual(await r.openCapacitySettings('icloud-drive'), { ok: true });
    assert.equal(opened.length, 1);
    assert.match(opened[0] ?? '', /systempreferences/u);
    assert.deepEqual(await r.openCapacitySettings('pcloud'), { ok: false }, 'a provider with in-app capacity does not route out');
    assert.equal(opened.length, 1);
  });

  test('iCloud capacity needs neither an availability probe nor a quota request (#721)', async () => {
    const bridge = new DeterministicICloudDriveBridge();
    let statusCalls = 0;
    const bridgeStatus = bridge.status.bind(bridge);
    bridge.status = () => {
      statusCalls += 1;
      return bridgeStatus();
    };
    let providerId: string | null = null;
    const { runtime: r } = runtime({
      iCloudDriveBridge: bridge,
      providerId: () => providerId,
      setProviderId: (id) => {
        providerId = id;
      },
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-icloud-capacity'), fault: undefined });
    assert.deepEqual(await r.connect('icloud-drive'), { ok: true, reason: null });
    const statusCallsBeforeCapacity = statusCalls;
    const provider = r.provider('icloud-drive');
    assert.ok(provider);
    let quotaCalls = 0;
    provider.quota = () => {
      quotaCalls += 1;
      return Promise.resolve({ usedBytes: 0, totalBytes: null });
    };

    assert.deepEqual(await r.storage('icloud-drive'), { capacity: null, capacityRoute: 'system-settings' });
    assert.equal(statusCalls, statusCallsBeforeCapacity);
    assert.equal(quotaCalls, 0);
  });

  test('iCloud authority custody is sealed, rejects malformed state, and clears on disconnect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'overlook-runtime-icloud-custody-'));
    const credentialDir = join(root, 'provider-auth', 'icloud-drive');
    const sealedSafeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').replace(/^sealed:/u, ''),
    };
    const store = new ICloudDriveAuthorityStore(sealedSafeStorage, credentialDir);
    store.save({ accountId: '0123456789abcdef', accountLabel: 'Test iCloud account' });
    assert.equal(store.load(), '0123456789abcdef');
    assert.deepEqual(store.loadRecord(), { accountId: '0123456789abcdef', accountLabel: 'Test iCloud account' });
    assert.notEqual(readFileSync(join(credentialDir, 'icloud-drive-authority.bin'), 'utf8'), '0123456789abcdef');

    writeFileSync(join(credentialDir, 'icloud-drive-authority.bin'), Buffer.from('malformed'));
    assert.equal(store.load(), null);

    let providerId: string | null = null;
    const { runtime: r } = runtime({
      dataDir: () => join(root, 'library'),
      providerCredentialDir: (id) => join(root, 'provider-auth', id),
      providerId: () => providerId,
      setProviderId: (id) => {
        providerId = id;
      },
      safeStorage: () => sealedSafeStorage,
    });
    r.buildProvider({ mockRootDir: join(root, 'mock'), fault: undefined });
    assert.equal((await r.connect('icloud-drive')).ok, true);
    assert.equal(providerId, 'icloud-drive');
    assert.equal((await r.disconnect('icloud-drive')).ok, true);
    assert.equal(providerId, null);
    assert.equal(store.load(), null);
  });

  test('iCloud unavailability is descriptor-driven and never changes selection', async () => {
    const bridge = new DeterministicICloudDriveBridge();
    bridge.setAvailable(false);
    let providerId: string | null = null;
    const { runtime: r } = runtime({
      iCloudDriveBridge: bridge,
      providerId: () => providerId,
      setProviderId: (id) => {
        providerId = id;
      },
    });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-icloud-unavailable'), fault: undefined });
    const descriptor = (await r.descriptors()).find(({ id }) => id === 'icloud-drive');
    assert.deepEqual(
      { available: descriptor?.available, reason: descriptor?.unavailableReason },
      { available: false, reason: 'Sign in to iCloud Drive in macOS Settings.' },
    );
    assert.deepEqual(await r.connect('icloud-drive'), { ok: false, reason: 'Sign in to iCloud Drive in macOS Settings.' });
    assert.equal(providerId, null);
  });

  test('iCloud connect preserves the precise reason when availability changes after descriptor probing', async () => {
    const bridge = new DeterministicICloudDriveBridge();
    let probes = 0;
    const status = bridge.status.bind(bridge);
    bridge.status = () => {
      probes += 1;
      return probes === 1 ? status() : Promise.resolve({ available: false, reason: 'unentitled', accountToken: null, accountLabel: null });
    };
    const { runtime: r } = runtime({ iCloudDriveBridge: bridge });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-icloud-status-race'), fault: undefined });
    assert.deepEqual(await r.connect('icloud-drive'), { ok: false, reason: 'This build is not entitled for iCloud Drive.' });
  });

  test('a persisted iCloud selection without sealed authority cannot browse or mutate the current OS account', async () => {
    const { runtime: r } = runtime({ providerId: () => 'icloud-drive' });
    r.buildProvider({ mockRootDir: join(tmpdir(), 'overlook-runtime-icloud-untrusted'), fault: undefined });
    assert.equal(r.activeId(), null);
    assert.equal(await r.provider('icloud-drive')?.authState(), 'not-connected');
    await assert.rejects(r.restoreSources('icloud-drive'), /account authority is not connected/u);
  });

  test('pCloud custody migrates out of the replaceable library directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'overlook-runtime-custody-'));
    const dataDir = join(root, 'library');
    const credentialDir = join(root, 'provider-auth', 'pcloud');
    const record = {
      accessToken: 'legacy-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-07-14T00:00:00.000Z',
    } as const;
    new PCloudTokenStore({ safeStorage: fakeSafeStorage, dataDir }).save(record);

    const { runtime: r } = runtime({ dataDir: () => dataDir, credentialDir: () => credentialDir });

    assert.deepEqual(r.tokenStore().load(), record);
    assert.equal(existsSync(join(credentialDir, 'pcloud-auth.bin')), true);
    assert.equal(existsSync(join(dataDir, 'pcloud-auth.bin')), false, 'legacy token is removed after migration');
  });

  test('provider-specific custody directories keep Google refresh tokens outside the library', async () => {
    const root = mkdtempSync(join(tmpdir(), 'overlook-runtime-google-custody-'));
    const { runtime: r } = runtime({
      dataDir: () => join(root, 'library'),
      providerCredentialDir: (id) => join(root, 'provider-auth', id),
      googleDriveClientId: () => 'desktop.apps.googleusercontent.com',
    });
    r.googleTokenStore().save({
      clientId: 'desktop.apps.googleusercontent.com',
      refreshToken: 'refresh-1',
      connectedAt: '2026-07-16T00:00:00.000Z',
    });
    const driveCredentialDir = join(root, 'provider-auth', 'google-drive');
    const paths = new GoogleDrivePathStore(driveCredentialDir);
    paths.setOverlookFolderId('old-account-root');
    paths.setFolderId('LIB_1', '', 'old-account-library');
    assert.equal(existsSync(join(root, 'provider-auth', 'google-drive', 'google-drive-auth.bin')), true);
    r.buildProvider({ mockRootDir: join(root, 'mock'), fault: undefined });
    assert.equal((await r.descriptors()).find(({ id }) => id === 'google-drive')?.available, true);
    assert.equal((await r.disconnect('google-drive')).ok, true);
    assert.equal(r.googleTokenStore().load(), null);
    const cleared = new GoogleDrivePathStore(driveCredentialDir);
    assert.equal(cleared.overlookFolderId(), null);
    assert.equal(cleared.folderId('LIB_1', ''), null);
  });

  test('library activation drops provider instances bound to the previous remote home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'overlook-runtime-library-rebind-'));
    let dataDir = join(root, 'library-a');
    const { runtime: r } = runtime({ dataDir: () => dataDir, providerCredentialDir: (id) => join(root, 'provider-auth', id) });
    r.buildProvider({ mockRootDir: join(root, 'mock'), fault: undefined });
    const previousMock = r.provider('mock');
    const previousPCloudTokenStore = r.tokenStore();
    const firstLibraryId = r.libraryId();

    dataDir = join(root, 'library-b');
    r.resetLibraryBinding();
    assert.equal(r.provider('mock'), undefined, 'status/data IPC cannot reuse a provider scoped to library A');
    assert.deepEqual(await r.descriptors(), []);

    r.buildProvider({ mockRootDir: join(root, 'mock'), fault: undefined });
    assert.notEqual(r.provider('mock'), previousMock);
    assert.notEqual(r.libraryId(), firstLibraryId, 'the rebuilt registry targets library B remote paths');
    assert.equal(r.tokenStore(), previousPCloudTokenStore, 'profile credential custody intentionally survives the switch');
  });

  test('library teardown drains the shared iCloud native bridge (#752)', async () => {
    class DrainObservedBridge extends DeterministicICloudDriveBridge {
      drainCalls = 0;

      override drain(): Promise<void> {
        this.drainCalls += 1;
        return Promise.resolve();
      }
    }
    const bridge = new DrainObservedBridge();
    const { runtime: r } = runtime({ iCloudDriveBridge: bridge });
    await r.drainICloudDriveOperations();
    assert.equal(bridge.drainCalls, 1);
  });
});

/** Options for a second instance against the same dataDir (restart shape). */
function baseOptions(): Omit<ProviderRuntimeOptions, 'dataDir'> {
  return {
    safeStorage: () => fakeSafeStorage,
    openExternal: () => Promise.resolve(),
    setProviderId: () => undefined,
    providerId: () => null,
    isPackaged: false,
    harnessEnv: () => undefined,
    pcloudEnabled: true,
    pcloudClientId: () => 'public-test-client',
    iCloudDriveBridge: new DeterministicICloudDriveBridge(),
  };
}
