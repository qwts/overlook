import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createFileProviderBridge } from '../../src/main/file-provider/file-provider-bridge.js';

describe('signed File Provider registration bridge (#797)', () => {
  test('ships a signed native lifecycle bridge and replicated extension', () => {
    const native = readFileSync(join(process.cwd(), 'native/touch-id/file_provider.mm'), 'utf8');
    const extension = readFileSync(join(process.cwd(), 'native/file-provider-extension/OverlookFileProvider.m'), 'utf8');
    for (const contract of [
      'SecStaticCodeCheckValidity',
      'NSFileProviderManager addDomain',
      'NSFileProviderManager removeDomain',
      'evictItemWithIdentifier',
      'signalEnumeratorForContainerItemIdentifier',
      'containerURLForSecurityApplicationGroupIdentifier',
    ]) {
      assert.ok(native.includes(contract), `native bridge must enforce ${contract}`);
    }
    for (const contract of [
      'NSFileProviderReplicatedExtension',
      'NSFileProviderItemCapabilitiesAllowsReading',
      'NSFileWriteNoPermissionError',
      '127.0.0.1',
      'Authorization',
    ]) {
      assert.ok(extension.includes(contract), `extension must enforce ${contract}`);
    }
    assert.match(readFileSync(join(process.cwd(), 'native/touch-id/file-provider.cjs'), 'utf8'), /file-provider\.node\.napi/u);
  });

  test('does not load native code off macOS or in unsigned builds', () => {
    let loads = 0;
    const loadBinding = () => {
      loads += 1;
      return {};
    };
    assert.deepEqual(createFileProviderBridge({ platform: 'linux', packaged: true, loadBinding }).status(), {
      available: false,
      reason: 'unsupported-platform',
    });
    assert.deepEqual(createFileProviderBridge({ platform: 'darwin', packaged: false, loadBinding }).status(), {
      available: false,
      reason: 'unsigned-build',
    });
    assert.equal(loads, 0);
  });

  test('requires both signed identities and forwards domain lifecycle operations', async () => {
    const calls: string[] = [];
    const callback = (name: string) => (_value: unknown, done: (error?: unknown) => void) => {
      calls.push(name);
      done();
    };
    const bridge = createFileProviderBridge({
      platform: 'darwin',
      packaged: true,
      loadBinding: () => ({
        status: (appId: string, extensionId: string) => appId === 'com.zts1.overlook' && extensionId.endsWith('.file-provider'),
        stateDirectory: () => '/group/file-provider',
        register: (domain: unknown, done: (error?: unknown) => void) => callback('register')(domain, done),
        remove: callback('remove'),
        evict: callback('evict'),
        changed: callback('changed'),
      }),
    });
    assert.deepEqual(bridge.status(), { available: true, reason: null });
    assert.equal(bridge.stateDirectory(), '/group/file-provider');
    await bridge.register({ id: 'domain', displayName: 'Library' });
    await bridge.changed('domain');
    await bridge.evict('domain');
    await bridge.remove('domain');
    assert.deepEqual(calls, ['register', 'changed', 'evict', 'remove']);
    bridge.close();
    assert.equal(bridge.status().available, false);
  });

  test('rejects native lifecycle failures without exposing arbitrary objects', async () => {
    const bridge = createFileProviderBridge({
      platform: 'darwin',
      packaged: true,
      loadBinding: () => ({
        status: () => true,
        stateDirectory: () => '/group/file-provider',
        register: (_domain: unknown, done: (error?: unknown) => void) => done({ secret: 'not stringified' }),
        remove: () => undefined,
        evict: () => undefined,
        changed: () => undefined,
      }),
    });
    await assert.rejects(bridge.register({ id: 'domain', displayName: 'Library' }), /operation failed/u);
  });

  test('fails closed when the signed bridge cannot open its app-group container', () => {
    const bridge = createFileProviderBridge({
      platform: 'darwin',
      packaged: true,
      loadBinding: () => ({
        status: () => true,
        stateDirectory: () => null,
        register: () => undefined,
        remove: () => undefined,
        evict: () => undefined,
        changed: () => undefined,
      }),
    });
    assert.deepEqual(bridge.status(), { available: false, reason: 'unsigned-build' });
  });
});
