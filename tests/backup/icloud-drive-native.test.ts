import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createNativeICloudDriveBridge, ICloudDriveNativeError } from '../../src/main/backup/icloud-drive/native-bridge.js';

const ACCOUNT_TOKEN = '0123456789abcdef';

function nativeBinding() {
  const calls: Array<readonly [string, ...unknown[]]> = [];
  let statusResult: unknown = { available: true, reason: null, accountToken: ACCOUNT_TOKEN, accountLabel: 'Owner iCloud' };
  let listResult: unknown = { entries: [], nextCursor: null, accountToken: ACCOUNT_TOKEN };
  let operationError: Error | undefined;
  const fail = (): void => {
    if (operationError !== undefined) throw operationError;
  };
  return {
    calls,
    setStatus: (value: unknown) => {
      statusResult = value;
    },
    setList: (value: unknown) => {
      listResult = value;
    },
    setError: (value: Error) => {
      operationError = value;
    },
    binding: {
      status: (bundleId: string, containerId: string) => {
        fail();
        calls.push(['status', bundleId, containerId]);
        return Promise.resolve(statusResult);
      },
      replaceFile: (bundleId: string, containerId: string, path: string, sourceFile: string, accountToken: string) => {
        fail();
        calls.push(['replaceFile', bundleId, containerId, path, sourceFile, accountToken]);
        return Promise.resolve();
      },
      materializeFile: (bundleId: string, containerId: string, path: string, destinationFile: string, accountToken: string) => {
        fail();
        calls.push(['materializeFile', bundleId, containerId, path, destinationFile, accountToken]);
        return Promise.resolve();
      },
      list: (bundleId: string, containerId: string, path: string, cursor: string | null, limit: number, accountToken: string) => {
        fail();
        calls.push(['list', bundleId, containerId, path, cursor, limit, accountToken]);
        return Promise.resolve(listResult);
      },
      delete: (bundleId: string, containerId: string, path: string, accountToken: string) => {
        fail();
        calls.push(['delete', bundleId, containerId, path, accountToken]);
        return Promise.resolve();
      },
    },
  };
}

describe('iCloud Drive native bridge gating (#656)', () => {
  test('native source resolves the entitled container and coordinates every file boundary', () => {
    const source = readFileSync(join(process.cwd(), 'native/touch-id/icloud_drive.mm'), 'utf8');
    const loader = readFileSync(join(process.cwd(), 'native/touch-id/icloud.cjs'), 'utf8');
    for (const contract of [
      'URLForUbiquityContainerIdentifier',
      'ubiquityIdentityToken',
      'NSFileCoordinator',
      'NSFileCoordinatorWritingForReplacing',
      'NSFileCoordinatorWritingForDeleting',
      'startDownloadingUbiquitousItemAtURL',
      'unresolvedConflictVersionsOfItemAtURL',
      'com.apple.developer.icloud-container-identifiers',
      'com.apple.developer.ubiquity-container-identifiers',
      'CloudDocuments',
    ]) {
      assert.ok(source.includes(contract), `native bridge must enforce ${contract}`);
    }
    assert.doesNotMatch(source, /Mobile Documents/u);
    assert.match(loader, /icloud\.node\.napi/u);
  });

  test('every async worker suppresses JavaScript completion after environment teardown (#752)', () => {
    const source = readFileSync(join(process.cwd(), 'native/touch-id/icloud_drive.mm'), 'utf8');
    assert.match(source, /napi_add_env_cleanup_hook/u);
    assert.match(source, /class TeardownSafeWorker/u);
    assert.match(source, /if \(!environmentAlive_->load\(std::memory_order_acquire\)\) return;/u);
    assert.match(source, /Napi::AsyncWorker::OnWorkComplete\(env, status\);/u);
    assert.equal(
      source.match(/public TeardownSafeWorker/gu)?.length,
      2,
      'status and operation workers must both use the guarded completion path',
    );
  });

  test('unsupported and unpackaged processes never load the native module', async () => {
    let loads = 0;
    const loadBinding = () => {
      loads += 1;
      return nativeBinding().binding;
    };
    const unsupported = createNativeICloudDriveBridge({ platform: 'win32', packaged: true, loadBinding });
    const unsigned = createNativeICloudDriveBridge({ platform: 'darwin', packaged: false, loadBinding });
    assert.deepEqual(await unsupported.status(), {
      available: false,
      reason: 'unsupported-platform',
      accountToken: null,
      accountLabel: null,
    });
    assert.deepEqual(await unsigned.status(), { available: false, reason: 'unsigned-build', accountToken: null, accountLabel: null });
    assert.equal(loads, 0);
    await assert.rejects(unsigned.delete('Overlook/library/object', ACCOUNT_TOKEN), errorWithCode('unavailable'));
  });

  test('missing and malformed native modules fail closed', async () => {
    const missing = createNativeICloudDriveBridge({
      platform: 'darwin',
      packaged: true,
      loadBinding: () => {
        throw new Error('not installed');
      },
    });
    const malformed = createNativeICloudDriveBridge({ platform: 'darwin', packaged: true, loadBinding: () => ({}) });
    assert.deepEqual(await missing.status(), { available: false, reason: 'native-unavailable', accountToken: null, accountLabel: null });
    assert.deepEqual(await malformed.status(), { available: false, reason: 'native-unavailable', accountToken: null, accountLabel: null });
  });
});

describe('iCloud Drive native bridge contract (#656)', () => {
  test('pins identities and forwards coordinated file operations', async () => {
    const native = nativeBinding();
    const bridge = createNativeICloudDriveBridge({ platform: 'darwin', packaged: true, loadBinding: () => native.binding });
    assert.deepEqual(await bridge.status(), {
      available: true,
      reason: null,
      accountToken: ACCOUNT_TOKEN,
      accountLabel: 'Owner iCloud',
    });
    await bridge.replaceFile('Overlook/library/object', '/tmp/source', ACCOUNT_TOKEN);
    await bridge.materializeFile('Overlook/library/object', '/tmp/destination', ACCOUNT_TOKEN);
    await bridge.list('Overlook/library', null, 100, ACCOUNT_TOKEN);
    await bridge.delete('Overlook/library/object', ACCOUNT_TOKEN);
    assert.deepEqual(native.calls, [
      ['status', 'com.zts1.overlook', 'iCloud.com.zts1.overlook'],
      ['replaceFile', 'com.zts1.overlook', 'iCloud.com.zts1.overlook', 'Overlook/library/object', '/tmp/source', ACCOUNT_TOKEN],
      ['materializeFile', 'com.zts1.overlook', 'iCloud.com.zts1.overlook', 'Overlook/library/object', '/tmp/destination', ACCOUNT_TOKEN],
      ['list', 'com.zts1.overlook', 'iCloud.com.zts1.overlook', 'Overlook/library', null, 100, ACCOUNT_TOKEN],
      ['delete', 'com.zts1.overlook', 'iCloud.com.zts1.overlook', 'Overlook/library/object', ACCOUNT_TOKEN],
    ]);
  });

  test('preserves entitlement and account availability while malformed status fails closed', async () => {
    const native = nativeBinding();
    const bridge = createNativeICloudDriveBridge({ platform: 'darwin', packaged: true, loadBinding: () => native.binding });
    for (const reason of ['unentitled', 'account-unavailable'] as const) {
      native.setStatus({ available: false, reason, accountToken: null });
      assert.deepEqual(await bridge.status(), { available: false, reason, accountToken: null, accountLabel: null });
    }
    native.setStatus({ available: true, reason: null, accountToken: 'account detail' });
    assert.deepEqual(await bridge.status(), { available: false, reason: 'native-unavailable', accountToken: null, accountLabel: null });
  });

  test('maps only stable offline, account-change, materialization, conflict, and replacement errors', async () => {
    const native = nativeBinding();
    const bridge = createNativeICloudDriveBridge({ platform: 'darwin', packaged: true, loadBinding: () => native.binding });
    for (const code of ['offline', 'account-changed', 'materialization-delayed', 'conflict', 'io-failure'] as const) {
      native.setError(Object.assign(new Error('native detail'), { code }));
      await assert.rejects(bridge.replaceFile('Overlook/library/object', '/tmp/source', ACCOUNT_TOKEN), errorWithCode(code));
    }
    native.setError(new Error('unknown'));
    await assert.rejects(bridge.delete('Overlook/library/object', ACCOUNT_TOKEN), errorWithCode('unavailable'));
  });

  test('rejects unsafe paths, files, cursors, limits, and stale-shaped account tokens before native access', async () => {
    const native = nativeBinding();
    const bridge = createNativeICloudDriveBridge({ platform: 'darwin', packaged: true, loadBinding: () => native.binding });
    await assert.rejects(bridge.delete('../escape', ACCOUNT_TOKEN), errorWithCode('invalid-path'));
    await assert.rejects(bridge.delete('Overlook//object', ACCOUNT_TOKEN), errorWithCode('invalid-path'));
    await assert.rejects(bridge.delete('Overlook/', ACCOUNT_TOKEN), errorWithCode('invalid-path'));
    await assert.rejects(bridge.replaceFile('Overlook/object', 'relative', ACCOUNT_TOKEN), errorWithCode('invalid-path'));
    await assert.rejects(bridge.list('Overlook', 'cursor', 100, ACCOUNT_TOKEN), errorWithCode('invalid-path'));
    await assert.rejects(bridge.list('Overlook', null, 0, ACCOUNT_TOKEN), errorWithCode('invalid-path'));
    await assert.rejects(bridge.delete('Overlook/object', 'changed'), errorWithCode('account-changed'));
    assert.equal(native.calls.length, 0);
  });

  test('validates metadata pages and carries the account token through pagination', async () => {
    const native = nativeBinding();
    const bridge = createNativeICloudDriveBridge({ platform: 'darwin', packaged: true, loadBinding: () => native.binding });
    native.setList({
      entries: [
        {
          path: 'Overlook/library/object',
          size: 42,
          modifiedAt: '2026-07-21T12:00:00.000Z',
          downloaded: false,
          conflicted: true,
        },
      ],
      nextCursor: '1',
      accountToken: ACCOUNT_TOKEN,
    });
    assert.deepEqual(await bridge.list('Overlook/library', '0', 1, ACCOUNT_TOKEN), {
      entries: [
        {
          path: 'Overlook/library/object',
          size: 42,
          modifiedAt: '2026-07-21T12:00:00.000Z',
          downloaded: false,
          conflicted: true,
        },
      ],
      nextCursor: '1',
      accountToken: ACCOUNT_TOKEN,
    });
    native.setList({ entries: [{ path: '../escape' }], nextCursor: null, accountToken: ACCOUNT_TOKEN });
    await assert.rejects(bridge.list('Overlook', null, 100, ACCOUNT_TOKEN), errorWithCode('io-failure'));
  });

  test('drains raw native work, including failures and operations added during the drain (#752)', async () => {
    const native = nativeBinding();
    const settlements: Array<{
      readonly resolve: () => void;
      readonly reject: (error: Error) => void;
    }> = [];
    native.binding.delete = () =>
      new Promise<void>((resolve, reject) => {
        settlements.push({ resolve, reject });
      });
    const bridge = createNativeICloudDriveBridge({
      platform: 'darwin',
      packaged: true,
      loadBinding: () => native.binding,
    });

    const firstOutcome = bridge.delete('Overlook/library/first', ACCOUNT_TOKEN).then(
      () => null,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settlements.length, 1);

    let drained = false;
    const draining = bridge.drain().then(() => {
      drained = true;
    });
    const second = bridge.delete('Overlook/library/second', ACCOUNT_TOKEN);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settlements.length, 2);

    settlements[0]?.reject(Object.assign(new Error('offline'), { code: 'offline' }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false, 'work added during the drain remains inside the barrier');

    settlements[1]?.resolve();
    await draining;
    await second;
    assert.equal(drained, true);
    assert.equal(errorWithCode('offline')(await firstOutcome), true, 'the caller still receives the mapped native failure');
  });
});

function errorWithCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ICloudDriveNativeError && error.code === code && error.message === 'iCloud Drive native operation failed';
}
