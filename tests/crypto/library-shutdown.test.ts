import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CustodyWorkTracker,
  drainBeforeDeadline,
  drainWithCancellationFence,
  releaseLibraryLockAfter,
} from '../../src/main/crypto/library-shutdown.js';

describe('library shutdown barrier (#311)', () => {
  test('releases the advisory lock when a vanished volume makes teardown fail', async () => {
    let released = false;
    await assert.rejects(
      releaseLibraryLockAfter(
        () => Promise.reject(new Error('volume disconnected')),
        () => {
          released = true;
        },
      ),
      /volume disconnected/u,
    );
    assert.equal(released, true);
  });
  test('waits for active work before resolving', async () => {
    let release: (() => void) | undefined;
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    let drained = false;
    const drain = drainBeforeDeadline([active], 100).then(() => {
      drained = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    release?.();
    await drain;
    assert.equal(drained, true);
  });

  test('rejects hung work so the controller can relaunch fail-closed', async () => {
    await assert.rejects(drainBeforeDeadline([new Promise(() => undefined)], 5), /did not drain/);
  });

  test('cancels work re-armed by a completion callback during the drain', async () => {
    let release: (() => void) | undefined;
    let scheduled = true;
    let cancellations = 0;
    const active = new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => {
      scheduled = true;
    });
    const draining = drainWithCancellationFence(
      () => {
        cancellations += 1;
        scheduled = false;
      },
      [active],
      100,
    );
    assert.equal(scheduled, false);
    release?.();
    await draining;
    assert.equal(scheduled, false);
    assert.equal(cancellations, 2);
  });

  test('custody work added during a drain also finishes before closure', async () => {
    const tracker = new CustodyWorkTracker();
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    void tracker.track(first);
    let drained = false;
    const draining = tracker.drain().then(() => {
      drained = true;
    });

    void tracker.track(second);
    releaseFirst?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false);

    releaseSecond?.();
    await draining;
    assert.equal(drained, true);
  });
});
