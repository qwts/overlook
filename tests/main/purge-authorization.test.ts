import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { purgeAfterAuthorization } from '../../src/main/library/purge-authorization.js';

describe('permanent purge authorization', () => {
  test('denial is typed cancellation and performs no purge or activity work', async () => {
    let purgeCalls = 0;
    let activityCalls = 0;
    const requested = ['P1', 'P2'];

    const outcome = await purgeAfterAuthorization(
      requested,
      null,
      () => ({
        purge: () => {
          purgeCalls += 1;
          return Promise.resolve({ purged: 2, skipped: 0, protected: 0, remoteFailures: 0 });
        },
      }),
      (photoIds, parent) => {
        assert.deepEqual(photoIds, requested);
        assert.equal(Object.isFrozen(photoIds), true);
        assert.equal(parent, null);
        return Promise.resolve(false);
      },
      () => ({
        record: () => {
          activityCalls += 1;
        },
      }),
    );

    assert.deepEqual(outcome, { status: 'cancelled' });
    assert.equal(purgeCalls, 0);
    assert.equal(activityCalls, 0);
  });

  test('approval binds the exact immutable snapshot and preserves activity reporting', async () => {
    let authorizedSnapshot: readonly string[] | undefined;
    let purgedSnapshot: readonly string[] | undefined;
    const activities: unknown[] = [];
    const outcome = await purgeAfterAuthorization(
      ['P1', 'P2'],
      null,
      () => ({
        purge: (photoIds) => {
          purgedSnapshot = photoIds;
          return Promise.resolve({ purged: 1, skipped: 1, protected: 1, remoteFailures: 0 });
        },
      }),
      (photoIds) => {
        authorizedSnapshot = photoIds;
        return Promise.resolve(true);
      },
      () => ({
        record: (activity) => {
          activities.push(activity);
        },
      }),
    );

    assert.strictEqual(purgedSnapshot, authorizedSnapshot);
    assert.equal(Object.isFrozen(purgedSnapshot), true);
    assert.deepEqual(outcome, {
      status: 'completed',
      result: { purged: 1, skipped: 1, protected: 1, remoteFailures: 0 },
    });
    assert.deepEqual(activities, [
      {
        eventType: 'photo.purged',
        outcome: 'partial',
        payload: { count: 1, skipped: 1, remoteFailures: 0 },
      },
    ]);
  });
});
