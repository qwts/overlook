import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { registerKeyringHandlersWith } from '../../src/main/crypto/keyring-ipc.js';
import type { KeyringService } from '../../src/main/crypto/keyring-service.js';
import { channels } from '../../src/shared/ipc/channels.js';
import { fakeRegistrar, INVALID_REQUEST, withQuietConsole } from '../ipc/fake-registrar.js';

// #517 / ADR-0032 §2: registry facts cross the boundary; key material only
// ever as a password-sealed file path. Every channel admits first.

describe('keyring IPC adapters (#517)', () => {
  test('admits every channel and projects list, export, pick, import, preflight, remove, and label', async () => {
    const { registrar, invoke, channels: registered } = fakeRegistrar();
    let admitted = 0;
    const calls: unknown[][] = [];
    const usage = { photos: 2, sidecars: 1, bytes: 300 };
    const service = {
      list: () => [],
      exportKey: (...args: unknown[]) => {
        calls.push(['exportKey', ...args]);
        return Promise.resolve('/keys/overlook-key-2.okey');
      },
      pickFile: () => Promise.resolve(null),
      importKey: (...args: unknown[]) => {
        calls.push(['importKey', ...args]);
        return Promise.resolve({ outcome: 'imported', keyId: 2, fingerprint: 'ab12', unlocked: 3, reason: null });
      },
      removePreflight: (...args: unknown[]) => {
        calls.push(['removePreflight', ...args]);
        return { allowed: true, reason: null, tier: 'irreversible', usage, entry: null };
      },
      remove: (...args: unknown[]) => {
        calls.push(['remove', ...args]);
        return { removed: true, reason: null, locked: 2 };
      },
      setLabel: (...args: unknown[]) => {
        calls.push(['setLabel', ...args]);
      },
    } as unknown as KeyringService;
    registerKeyringHandlersWith(
      () => service,
      () => {
        admitted += 1;
      },
      registrar,
    );
    assert.equal(registered().length, 7);

    assert.deepEqual(await invoke(channels.keyringList.name, {}), { keys: [] });
    assert.deepEqual(await invoke(channels.keyringExport.name, { id: 2, password: 'correct horse' }), {
      path: '/keys/overlook-key-2.okey',
    });
    assert.deepEqual(await invoke(channels.keyringPickFile.name, {}), { path: null });
    assert.deepEqual(await invoke(channels.keyringImport.name, { path: '/keys/k.okey', password: 'pw' }), {
      outcome: 'imported',
      keyId: 2,
      fingerprint: 'ab12',
      unlocked: 3,
      reason: null,
    });
    assert.deepEqual(await invoke(channels.keyringRemovePreflight.name, { id: 2 }), {
      allowed: true,
      reason: null,
      tier: 'irreversible',
      usage,
      entry: null,
    });
    assert.deepEqual(await invoke(channels.keyringRemove.name, { id: 2, authorization: 'REMOVE KEY 2' }), {
      removed: true,
      reason: null,
      locked: 2,
    });
    assert.deepEqual(await invoke(channels.keyringSetLabel.name, { id: 2, label: '  Studio  ' }), {});
    assert.deepEqual(calls, [
      ['exportKey', 2, 'correct horse'],
      ['importKey', '/keys/k.okey', 'pw'],
      ['removePreflight', 2],
      ['remove', 2, 'REMOVE KEY 2'],
      ['setLabel', 2, 'Studio'],
    ]);
    assert.equal(admitted, 7);
  });

  test('refuses a short export password and an over-long label before admitting', async () => {
    const { registrar, invoke } = fakeRegistrar();
    let admitted = 0;
    registerKeyringHandlersWith(
      () => ({}) as KeyringService,
      () => {
        admitted += 1;
      },
      registrar,
    );
    const logged = await withQuietConsole(async () => {
      assert.deepEqual(await invoke(channels.keyringExport.name, { id: 1, password: 'short' }), INVALID_REQUEST);
      assert.deepEqual(await invoke(channels.keyringSetLabel.name, { id: 1, label: 'x'.repeat(81) }), INVALID_REQUEST);
    });
    assert.equal(admitted, 0);
    assert.equal(logged.length, 2);
  });
});
