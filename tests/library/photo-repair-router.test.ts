import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPhotoRepairRouter } from '../../src/main/library/photo-repair-router.js';
import { retryPhotoRepair } from '../../src/main/library/photo-repair-ipc.js';
import type { RepairablePhoto } from '../../src/shared/commands/photo-repair.js';

for (const fileKind of ['jpeg', 'video'] as const) {
  test(`explicit ${fileKind} repair reaches only its matching service and waits for the requested row (#1098)`, async () => {
    let photo: RepairablePhoto = {
      id: 'requested',
      fileKind,
      deletedAt: null,
      locked: false,
      syncState: 'local',
      previewFailure: 'decode-failed',
      dimensionStatus: 'unavailable',
    };
    const calls: string[] = [];
    const repair =
      (kind: string) =>
      (id: string): Promise<void> => {
        calls.push(`${kind}:${id}`);
        photo = { ...photo, previewFailure: null, dimensionStatus: 'verified' };
        return Promise.resolve();
      };
    const router = createPhotoRepairRouter({ getPhoto: () => photo, repairImage: repair('image'), captureVideo: repair('video') });
    assert.deepEqual(await retryPhotoRepair({ ...router, getPhoto: () => photo, isCurrent: () => true }, photo.id), { status: 'repaired' });
    assert.deepEqual(calls, [`${fileKind === 'video' ? 'video' : 'image'}:requested`]);
    await router.repairPhoto(photo.id);
    assert.equal(calls.length, 1, 'healthy rows do not enter either service');
    photo = { ...photo, previewFailure: 'decode-failed', locked: true };
    await router.repairPhoto(photo.id);
    assert.equal(calls.length, 1, 'custody is rechecked at routing');
  });
}
