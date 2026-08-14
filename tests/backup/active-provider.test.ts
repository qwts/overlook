import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { createActiveProvider } from '../../src/main/backup/active-provider.js';
import type { StorageProvider } from '../../src/main/backup/provider.js';

// #256: the delegator that lets the engine keep one provider reference while
// the user switches mid-session.

function fake(id: string): StorageProvider {
  return {
    id,
    label: id,
    capabilities: {
      quota: 'known',
      verification: 'server-checksum',
      resumableUpload: false,
      platforms: ['darwin'],
      interactiveAuth: false,
      reconnectRequired: false,
      accountIdentity: 'stable-subject',
    },
    listLibraries: () => Promise.resolve([id]),
    forLibrary: () => fake(id),
    authState: () => Promise.resolve('connected' as const),
    accountIdentity: () => Promise.resolve({ accountId: id, accountLabel: id }),
    put: () => Promise.resolve({ bytes: 1 }),
    getStream: () => Promise.reject(new Error('unused')),
    probe: () => Promise.resolve({ bytes: 1 }),
    list: () => Promise.resolve([{ path: `${id}/entry`, bytes: 1 }]),
    delete: () => Promise.resolve(),
    quota: () => Promise.resolve({ usedBytes: id.length, totalBytes: 100 }),
    verify: () => Promise.resolve({ sha256: id, bytes: 1 }),
  };
}

describe('active-provider delegator (#256)', () => {
  test('every call follows the CURRENT choice; disconnected falls back to the default target', async () => {
    const registry = new Map<string, StorageProvider>([
      ['mock', fake('mock')],
      ['pcloud', fake('pcloud')],
    ]);
    let active: string | null = 'mock';
    const provider = createActiveProvider({ registry, activeId: () => active, defaultId: () => 'pcloud' });

    assert.equal(provider.id, 'mock');
    assert.deepEqual(await provider.list('x'), [{ path: 'mock/entry', bytes: 1 }]);

    active = 'pcloud';
    assert.equal(provider.id, 'pcloud', 'same reference, new delegate — no engine rebuild needed');
    assert.deepEqual(await provider.verify('x'), { sha256: 'pcloud', bytes: 1 });

    active = null;
    assert.equal(provider.id, 'pcloud', 'disconnected delegates to the Connect target');
  });

  test('backup writes route exclusively through settings.providerId (#721)', async () => {
    const writes: string[] = [];
    const recording = (id: string): StorageProvider => ({
      ...fake(id),
      put: () => {
        writes.push(id);
        return Promise.resolve({ bytes: 1 });
      },
    });
    const registry = new Map<string, StorageProvider>([
      ['google-drive', recording('google-drive')],
      ['pcloud', recording('pcloud')],
      ['icloud-drive', recording('icloud-drive')],
    ]);
    let selected = 'google-drive';
    const provider = createActiveProvider({ registry, activeId: () => selected, defaultId: () => 'pcloud' });

    await provider.put('blobs/aa/google', Readable.from([Buffer.from('g')]));
    selected = 'pcloud';
    await provider.put('blobs/bb/pcloud', Readable.from([Buffer.from('p')]));
    selected = 'icloud-drive';
    await provider.put('blobs/cc/icloud', Readable.from([Buffer.from('i')]));

    assert.deepEqual(writes, ['google-drive', 'pcloud', 'icloud-drive']);
  });

  test('an active id this build never registered falls back to the default (stale packaged "mock")', () => {
    const registry = new Map<string, StorageProvider>([['pcloud', fake('pcloud')]]);
    const provider = createActiveProvider({ registry, activeId: () => 'mock', defaultId: () => 'pcloud' });
    assert.equal(provider.id, 'pcloud');
  });

  test('an empty registry fails loudly', () => {
    const provider = createActiveProvider({ registry: new Map(), activeId: () => null, defaultId: () => 'pcloud' });
    assert.throws(() => provider.id, /no storage provider registered/u);
  });
});
