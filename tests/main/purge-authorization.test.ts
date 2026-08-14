import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { purgeAfterAuthorization } from '../../src/main/ipc.js';

describe('permanent purge authorization', () => {
  test('does not reach the purge facade when main-process confirmation is denied', async () => {
    let purgeCalled = false;
    const result = await purgeAfterAuthorization(
      ['P1'],
      () => ({
        purge: () => {
          purgeCalled = true;
          return Promise.resolve({ purged: 1, skipped: 0, protected: 0, remoteFailures: 0 });
        },
      }),
      () => Promise.resolve(false),
    );

    assert.equal(purgeCalled, false);
    assert.deepEqual(result, { purged: 0, skipped: 0, protected: 0, remoteFailures: 0 });
  });

  test('binds confirmation to the exact photo snapshot before purging', async () => {
    const authorized: string[][] = [];
    const purged: string[][] = [];
    await purgeAfterAuthorization(
      ['P1', 'P2'],
      () => ({
        purge: (photoIds) => {
          purged.push([...photoIds]);
          return Promise.resolve({ purged: 2, skipped: 0, protected: 0, remoteFailures: 0 });
        },
      }),
      (photoIds) => {
        authorized.push([...photoIds]);
        return Promise.resolve(true);
      },
    );

    assert.deepEqual(authorized, [['P1', 'P2']]);
    assert.deepEqual(purged, [['P1', 'P2']]);
  });
});
