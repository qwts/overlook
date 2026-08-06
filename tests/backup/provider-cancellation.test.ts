import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { GoogleDriveAuthClient } from '../../src/main/backup/google-drive/auth-client.js';
import { GoogleDrivePathStore } from '../../src/main/backup/google-drive/path-store.js';
import { GoogleDriveProvider } from '../../src/main/backup/google-drive/google-drive-provider.js';
import { GoogleDriveTokenStore } from '../../src/main/backup/google-drive/token-store.js';
import { ICloudDriveProvider } from '../../src/main/backup/icloud-drive/icloud-drive-provider.js';
import type {
  ICloudDriveNativeBridge,
  ICloudDriveNativeListPage,
  ICloudDriveNativeStatus,
} from '../../src/main/backup/icloud-drive/native-bridge.js';
import { PCloudProvider } from '../../src/main/backup/pcloud/pcloud-provider.js';
import type { StorageProvider } from '../../src/main/backup/provider.js';
import type { SafeStorageLike } from '../../src/main/crypto/keystore.js';

const GOOGLE_CLIENT_ID = 'cancellation.apps.googleusercontent.com';
const LIBRARY_ID = 'CANCELLATION_LIBRARY';
const ACCOUNT_TOKEN = 'a'.repeat(32);
const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
};

type StorageOperation = 'listLibraries' | 'list' | 'quota';

function invoke(provider: StorageProvider, operation: StorageOperation, signal: AbortSignal): Promise<unknown> {
  if (operation === 'listLibraries') return provider.listLibraries(signal);
  if (operation === 'list') return provider.list('.', signal);
  return provider.quota(signal);
}

function stalledFetch(): { readonly fetchImpl: typeof fetch; readonly started: Promise<void> } {
  let notify!: () => void;
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal instanceof AbortSignal, 'storage fetch receives the runtime cancellation signal');
      notify();
      const fail = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    })) as typeof fetch;
  return { fetchImpl, started };
}

function googleProvider(fetchImpl: typeof fetch): GoogleDriveProvider {
  const tokenStore = new GoogleDriveTokenStore({
    safeStorage,
    dataDir: mkdtempSync(join(tmpdir(), 'overlook-google-cancellation-auth-')),
  });
  tokenStore.save({ clientId: GOOGLE_CLIENT_ID, refreshToken: 'refresh', connectedAt: 'now' });
  const auth = new GoogleDriveAuthClient({ clientId: () => GOOGLE_CLIENT_ID, tokenStore, fetchImpl });
  auth.seed('access', 3600);
  return new GoogleDriveProvider({
    auth,
    paths: new GoogleDrivePathStore(mkdtempSync(join(tmpdir(), 'overlook-google-cancellation-paths-'))),
    libraryId: LIBRARY_ID,
    fetchImpl,
  });
}

function pCloudProvider(fetchImpl: typeof fetch): PCloudProvider {
  return new PCloudProvider({
    auth: () => ({ accessToken: 'token', apiHost: 'api.pcloud.com', connectedAt: 'now' }),
    libraryId: LIBRARY_ID,
    fetchImpl,
  });
}

function iCloudProvider(operation: StorageOperation): { readonly provider: ICloudDriveProvider; readonly started: Promise<void> } {
  let notify!: () => void;
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const stalledStatus = (): Promise<ICloudDriveNativeStatus> =>
    new Promise<ICloudDriveNativeStatus>(() => {
      notify();
    });
  const stalledList = (): Promise<ICloudDriveNativeListPage> =>
    new Promise<ICloudDriveNativeListPage>(() => {
      notify();
    });
  const bridge: ICloudDriveNativeBridge = {
    drain: () => Promise.resolve(),
    status: () =>
      operation === 'quota'
        ? stalledStatus()
        : Promise.resolve({ available: true, reason: null, accountToken: ACCOUNT_TOKEN, accountLabel: 'Test account' }),
    list: () => stalledList(),
    replaceFile: () => Promise.reject(new Error('unused')),
    materializeFile: () => Promise.reject(new Error('unused')),
    delete: () => Promise.reject(new Error('unused')),
  };
  return {
    provider: new ICloudDriveProvider({ bridge, libraryId: LIBRARY_ID, accountToken: ACCOUNT_TOKEN }),
    started,
  };
}

for (const operation of ['listLibraries', 'list', 'quota'] as const) {
  test(`Google Drive ${operation} propagates cancellation (#721)`, async () => {
    const stalled = stalledFetch();
    const controller = new AbortController();
    const pending = invoke(googleProvider(stalled.fetchImpl), operation, controller.signal);
    await stalled.started;
    controller.abort(new Error('deadline'));
    await assert.rejects(pending);
  });

  test(`pCloud ${operation} propagates cancellation (#721)`, async () => {
    const stalled = stalledFetch();
    const controller = new AbortController();
    const pending = invoke(pCloudProvider(stalled.fetchImpl), operation, controller.signal);
    await stalled.started;
    controller.abort(new Error('deadline'));
    await assert.rejects(pending);
  });

  test(`iCloud Drive ${operation} ignores a late native result after cancellation (#721)`, async () => {
    const stalled = iCloudProvider(operation);
    const controller = new AbortController();
    const pending = invoke(stalled.provider, operation, controller.signal);
    await stalled.started;
    controller.abort(new Error('deadline'));
    await assert.rejects(pending);
  });
}
