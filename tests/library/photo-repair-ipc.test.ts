import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerPhotoRepairHandlers, retryPhotoRepair } from '../../src/main/library/photo-repair-ipc.js';
import { channels } from '../../src/shared/ipc/channels.js';
import type { RepairablePhoto } from '../../src/shared/commands/photo-repair.js';
import { fakeRegistrar, INVALID_REQUEST, withQuietConsole } from '../ipc/fake-registrar.js';

const broken: RepairablePhoto = {
  id: 'requested',
  deletedAt: null,
  locked: false,
  syncState: 'local',
  fileKind: 'jpeg',
  previewFailure: 'corrupt',
  dimensionStatus: 'verified',
};

for (const reason of ['preview', 'dimensions'] as const) {
  test(`repair IPC reports the requested row after ${reason} repair, not another queued row (#1098)`, async () => {
    let photo = {
      ...broken,
      previewFailure: reason === 'preview' ? ('corrupt' as const) : null,
      dimensionStatus: reason === 'dimensions' ? ('unavailable' as const) : ('verified' as const),
    };
    const requested: string[] = [];
    const runtime = {
      getPhoto: (id: string) => {
        assert.equal(id, 'requested');
        return photo;
      },
      repairPhoto: (id: string) => {
        requested.push(id);
        return Promise.resolve();
      },
      isCurrent: () => true,
    };
    assert.deepEqual(await retryPhotoRepair(runtime, 'requested'), { status: 'failed' });
    runtime.repairPhoto = (id) => {
      requested.push(id);
      photo = { ...photo, previewFailure: null, dimensionStatus: 'verified' };
      return Promise.resolve();
    };
    assert.deepEqual(await retryPhotoRepair(runtime, 'requested'), { status: 'repaired' });
    assert.deepEqual(await retryPhotoRepair(runtime, 'requested'), { status: 'unchanged' });
    assert.deepEqual(requested, ['requested', 'requested']);
  });
}

for (const patch of [
  { locked: true },
  { syncState: 'offloaded' },
  { deletedAt: '2026-09-22' },
  { fileKind: 'audio' },
  { fileKind: 'other' },
] as const) {
  test(`repair refuses ${JSON.stringify(patch)} without opening the original (#1098)`, async () => {
    assert.deepEqual(
      await retryPhotoRepair(
        {
          getPhoto: () => ({ ...broken, ...patch }),
          repairPhoto: () => {
            throw new Error('must not decode');
          },
          isCurrent: () => true,
        },
        'requested',
      ),
      { status: 'unavailable' },
    );
  });
}

test('a changed library or authorization scope never reads the old database after repair (#1098)', async () => {
  let current = true;
  let reads = 0;
  assert.deepEqual(
    await retryPhotoRepair(
      {
        getPhoto: () => {
          assert.equal(current, true);
          reads++;
          return broken;
        },
        repairPhoto: () => {
          current = false;
          return Promise.resolve();
        },
        isCurrent: () => current,
      },
      'requested',
    ),
    { status: 'unavailable' },
  );
  assert.equal(reads, 1);
});

test('typed repair IPC validates and admits before reaching the runtime (#1098)', async () => {
  const fake = fakeRegistrar();
  let admitted = 0;
  let runtimes = 0;
  registerPhotoRepairHandlers(
    () => {
      runtimes++;
      return { getPhoto: () => undefined, repairPhoto: () => Promise.resolve(), isCurrent: () => true };
    },
    () => {
      admitted++;
    },
    fake.registrar,
  );
  await withQuietConsole(async () => assert.deepEqual(await fake.invoke(channels.photoRepair.name, { photoId: '' }), INVALID_REQUEST));
  assert.equal(admitted, 0);
  assert.equal(runtimes, 0);
  assert.deepEqual(await fake.invoke(channels.photoRepair.name, { photoId: 'missing' }), { status: 'unavailable' });
  assert.equal(admitted, 2);
  assert.equal(runtimes, 1);
  registerPhotoRepairHandlers(
    () => {
      throw new Error('must not reach runtime');
    },
    () => {
      throw new Error('locked');
    },
    fake.registrar,
  );
  await withQuietConsole(async () => {
    const result = await fake.invoke(channels.photoRepair.name, { photoId: 'requested' });
    assert.equal(typeof result, 'object');
    assert.notDeepEqual(result, { status: 'repaired' });
  });
});
