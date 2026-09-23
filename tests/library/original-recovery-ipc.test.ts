import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerOriginalRecoveryHandlers } from '../../src/main/library/original-recovery-ipc.js';
import { channels } from '../../src/shared/ipc/channels.js';
import { fakeRegistrar, INVALID_REQUEST, withQuietConsole } from '../ipc/fake-registrar.js';

test('recovery IPC validates IDs, admits before picking and again before recovering (#1101)', async () => {
  const { registrar, invoke } = fakeRegistrar();
  const calls: string[] = [];
  registerOriginalRecoveryHandlers(
    () => ({
      recover: (id, path) => {
        calls.push(`${id}:${path}`);
        return Promise.resolve('recovered');
      },
    }),
    () => {
      calls.push('admit');
    },
    () => 1,
    () => {
      calls.push('pick');
      return Promise.resolve('/chosen/file');
    },
    registrar,
  );
  await withQuietConsole(async () => {
    assert.deepEqual(await invoke(channels.photoRecoverOriginal.name, { photoId: '' }), INVALID_REQUEST);
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(await invoke(channels.photoRecoverOriginal.name, { photoId: 'photo' }), { status: 'recovered' });
  assert.deepEqual(calls, ['admit', 'pick', 'admit', 'photo:/chosen/file']);
});

test('cancelled picker or changed authorization never starts recovery (#1101)', async () => {
  for (const cancelled of [true, false]) {
    const { registrar, invoke } = fakeRegistrar();
    let epoch = 1;
    let recovered = false;
    registerOriginalRecoveryHandlers(
      () => ({
        recover: () => {
          recovered = true;
          return Promise.resolve('recovered');
        },
      }),
      () => undefined,
      () => epoch,
      () => {
        if (!cancelled) epoch += 1;
        return Promise.resolve(cancelled ? null : '/chosen/file');
      },
      registrar,
    );
    assert.deepEqual(await invoke(channels.photoRecoverOriginal.name, { photoId: 'photo' }), { status: 'cancelled' });
    assert.equal(recovered, false);
  }
});
