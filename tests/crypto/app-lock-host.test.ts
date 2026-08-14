import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AppLockHost, type AppLockControllerLike } from '../../src/main/crypto/app-lock-host.js';
import type { LockStateSnapshot } from '../../src/main/crypto/app-lock-controller.js';
import type { TouchIdStatus } from '../../src/main/crypto/touch-id.js';

// #385: the host lets bound-once consumers (IPC handlers, lifecycle
// listeners, external-open) follow a library switch — delegation targets the
// CURRENT controller and subscriptions survive a swap.

function fakeController(libraryId: string | null): AppLockControllerLike & {
  emit: (snapshot: LockStateSnapshot) => void;
  emitTouchId: (status: TouchIdStatus) => void;
  readonly log: string[];
} {
  const stateListeners = new Set<(snapshot: LockStateSnapshot) => void>();
  const touchIdListeners = new Set<(status: TouchIdStatus) => void>();
  const log: string[] = [];
  const snapshot: LockStateSnapshot = { state: 'unconfigured-unlocked', libraryId };
  return {
    log,
    emit: (next) => {
      for (const listener of stateListeners) listener(next);
    },
    emitTouchId: (status) => {
      for (const listener of touchIdListeners) listener(status);
    },
    initialize: () => {
      log.push('initialize');
      return Promise.resolve();
    },
    snapshot: () => snapshot,
    retryAfterMs: () => 0,
    subscribe: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    subscribeTouchId: (listener) => {
      touchIdListeners.add(listener);
      return () => touchIdListeners.delete(listener);
    },
    touchIdStatus: () => Promise.resolve({ available: false, reason: 'unsupported-platform', enabled: false, reenrollmentRequired: false }),
    requireContentAccess: () => log.push('requireContentAccess'),
    unlock: (password) => {
      log.push(`unlock:${password}`);
      return Promise.resolve({ ok: true as const });
    },
    authorize: (password) => {
      log.push(`authorize:${password}`);
      return Promise.resolve({ ok: true as const });
    },
    unlockWithTouchId: () => Promise.resolve({ ok: true as const }),
    enableTouchId: () => Promise.resolve({ ok: true as const }),
    disableTouchId: () => Promise.resolve(true),
    lock: () => {
      log.push('lock');
      return Promise.resolve();
    },
    configure: () => Promise.resolve(),
    changePassword: () => Promise.resolve({ ok: true }),
    remove: () => Promise.resolve({ ok: true }),
    recover: () => Promise.resolve(),
  };
}

describe('app-lock host (#385)', () => {
  test('delegates to the current inner controller', async () => {
    const inner = fakeController('lib-a');
    const host = new AppLockHost(inner);

    assert.equal(host.snapshot().libraryId, 'lib-a');
    await host.unlock('pw');
    host.requireContentAccess();
    await host.lock();
    assert.deepEqual(inner.log, ['unlock:pw', 'requireContentAccess', 'lock']);
  });

  test('ACCEPTANCE: subscriptions survive a swap — bound-once consumers follow the new library', async () => {
    const first = fakeController('lib-a');
    const host = new AppLockHost(first);

    const seen: (string | null)[] = [];
    host.subscribe((snapshot) => seen.push(snapshot.libraryId));

    first.emit({ state: 'unlocked', libraryId: 'lib-a' });
    assert.deepEqual(seen, ['lib-a'], 'forwards the first controller');

    const second = fakeController('lib-b');
    await host.swap(second);
    assert.deepEqual(second.log, ['initialize'], 'swap initializes the new controller');
    assert.deepEqual(seen, ['lib-a', 'lib-b'], 'swap announces the new state to existing listeners');

    second.emit({ state: 'locked', libraryId: 'lib-b' });
    assert.deepEqual(seen, ['lib-a', 'lib-b', 'lib-b'], 'listener now follows the second controller');

    first.emit({ state: 'unlocked', libraryId: 'lib-a' });
    assert.deepEqual(seen, ['lib-a', 'lib-b', 'lib-b'], 'the detached first controller no longer reaches listeners');

    assert.equal(host.snapshot().libraryId, 'lib-b', 'method delegation follows too');
  });

  test('unsubscribe removes host listeners and touch-id forwarding swaps as well', async () => {
    const first = fakeController('lib-a');
    const host = new AppLockHost(first);

    const states: string[] = [];
    const off = host.subscribe((snapshot) => states.push(snapshot.state));
    const touch: boolean[] = [];
    host.subscribeTouchId((status) => touch.push(status.enabled));

    first.emitTouchId({ available: true, reason: null, enabled: true, reenrollmentRequired: false });
    off();
    first.emit({ state: 'locked', libraryId: 'lib-a' });
    assert.deepEqual(states, [], 'unsubscribed listener never fires');
    assert.deepEqual(touch, [true]);

    const second = fakeController('lib-b');
    await host.swap(second);
    second.emitTouchId({ available: true, reason: null, enabled: false, reenrollmentRequired: false });
    assert.deepEqual(touch, [true, false], 'touch-id subscription followed the swap');
  });
});
