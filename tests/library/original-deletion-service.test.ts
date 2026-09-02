import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { OriginalDeletionService } from '../../src/main/library/original-deletion-service.js';
import type { AppLockState, AppAuthorizationResult } from '../../src/main/crypto/app-lock-controller.js';
import type { PhotoRecord } from '../../src/shared/library/types.js';

function photo(id: string, isOriginal = true): PhotoRecord {
  return {
    id,
    fileName: `${id}.jpg`,
    fileKind: 'jpeg',
    width: 1,
    height: 1,
    bytes: 1,
    contentHash: id.padEnd(64, '0'),
    derivativeKey: id.padEnd(64, '0'),
    variantSourceId: null,
    assetOwnerId: null,
    camera: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focalLength: null,
    takenAt: null,
    gpsLat: null,
    gpsLon: null,
    place: null,
    importedAt: '2026-07-21T00:00:00.000Z',
    importSource: 'test',
    favorite: false,
    isOriginal,
    keyId: 1,
    deletedAt: null,
    previewFailure: null,
    dimensionStatus: 'verified',
    mediaInfo: null,
    syncState: 'local',
    title: null,
    description: null,
    tags: [],
    userTags: [],
    importedKeywords: [],
    suppressedKeywords: [],
    metadataVersion: 1,
  };
}

function world(initialState: AppLockState) {
  let state = initialState;
  let libraryId = 'library-a';
  let now = 1_000;
  let authorizationEpoch = 0;
  let sequence = 0;
  const photos = new Map<string, PhotoRecord>([
    ['A', photo('A')],
    ['B', photo('B', false)],
  ]);
  const deleted: string[][] = [];
  let authorization: AppAuthorizationResult = { ok: true };
  const service = new OriginalDeletionService({
    getPhoto: (id) => photos.get(id),
    activeLibraryId: () => libraryId,
    authorizationEpoch: () => authorizationEpoch,
    lockState: () => state,
    authorizePassword: () => Promise.resolve(authorization),
    deletePermanently: (ids) => {
      deleted.push([...ids]);
      return Promise.resolve({ purged: ids.length, skipped: 0, protected: 0, remoteFailures: 0 });
    },
    now: () => now,
    newId: () => `challenge-${String(++sequence)}`,
  });
  return {
    service,
    photos,
    deleted,
    setState: (next: AppLockState) => {
      state = next;
      authorizationEpoch += 1;
    },
    setStateWithoutEpoch: (next: AppLockState) => {
      state = next;
    },
    switchLibrary: () => {
      libraryId = 'library-b';
    },
    expire: () => {
      now += 2 * 60 * 1000 + 1;
    },
    rejectPassword: () => {
      authorization = { ok: false, reason: 'wrong-password' };
    },
  };
}

describe('protected Original deletion ceremony (#482)', () => {
  test('unconfigured apps still require a fresh final-confirmation challenge', async () => {
    const w = world('unconfigured-unlocked');
    const preflight = w.service.preflight(['B', 'A', 'A']);
    assert.deepEqual(
      { count: preflight.count, protected: preflight.protected, passwordRequired: preflight.passwordRequired },
      { count: 2, protected: 1, passwordRequired: false },
    );
    assert.deepEqual(await w.service.commit(preflight.challengeId), {
      purged: 2,
      skipped: 0,
      protected: 0,
      remoteFailures: 0,
    });
    assert.deepEqual(w.deleted, [['A', 'B']]);
    await assert.rejects(w.service.commit(preflight.challengeId), /authorization is unavailable/u);
  });

  test('configured apps require successful password re-authentication', async () => {
    const w = world('unlocked');
    const preflight = w.service.preflight(['A']);
    await assert.rejects(w.service.commit(preflight.challengeId), /password authorization is required/u);
    w.rejectPassword();
    assert.deepEqual(await w.service.authorize(preflight.challengeId, 'wrong'), { ok: false, reason: 'wrong-password' });
    await assert.rejects(w.service.commit(preflight.challengeId), /password authorization is required/u);
  });

  test('library, lock, expiry, and classification changes invalidate authority', async () => {
    const switched = world('unconfigured-unlocked');
    const switchedId = switched.service.preflight(['A']).challengeId;
    switched.switchLibrary();
    await assert.rejects(switched.service.commit(switchedId), /authorization expired/u);

    const expired = world('unconfigured-unlocked');
    const expiredId = expired.service.preflight(['A']).challengeId;
    expired.expire();
    await assert.rejects(expired.service.commit(expiredId), /authorization expired/u);

    const relabeled = world('unconfigured-unlocked');
    const relabeledId = relabeled.service.preflight(['A']).challengeId;
    relabeled.photos.set('A', photo('A', false));
    await assert.rejects(relabeled.service.commit(relabeledId), /selection changed/u);

    const locked = world('unconfigured-unlocked');
    const lockedId = locked.service.preflight(['A']).challengeId;
    locked.setState('locked');
    await assert.rejects(locked.service.commit(lockedId), /authorization expired/u);
  });

  test('cancel and lock-state changes revoke a prepared ceremony', async () => {
    const cancelled = world('unconfigured-unlocked');
    const cancelledId = cancelled.service.preflight(['A']).challengeId;
    cancelled.service.cancel(cancelledId);
    await assert.rejects(cancelled.service.commit(cancelledId), /authorization is unavailable/u);

    const changed = world('unlocked');
    const changedId = changed.service.preflight(['A']).challengeId;
    assert.deepEqual(await changed.service.authorize(changedId, 'correct'), { ok: true });
    changed.setStateWithoutEpoch('unconfigured-unlocked');
    await assert.rejects(changed.service.commit(changedId), /app lock state changed/u);
  });
});
