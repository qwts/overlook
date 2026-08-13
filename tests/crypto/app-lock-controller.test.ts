import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AppLockController, AppLockedError } from '../../src/main/crypto/app-lock-controller.js';
import type { AppLockStatus, ConfigureAppLockInput, UnlockResult } from '../../src/main/crypto/app-lock-credentials.js';
import type { TouchIdEnableResult, TouchIdStatus, TouchIdUnlockResult } from '../../src/main/crypto/touch-id.js';

class FakeCredentials {
  credentialStatus: AppLockStatus = { state: 'locked', libraryId: 'library-a' };
  unlockResult: UnlockResult = { ok: true, masterKey: Buffer.alloc(32, 7) };
  recoveries = 0;
  anchorPolicyChanges = 0;
  passwordChanges = 0;
  removals = 0;
  readonly unlockPasswords: string[] = [];

  status(): AppLockStatus {
    return this.credentialStatus;
  }

  configure(_input: ConfigureAppLockInput): Promise<void> {
    return Promise.resolve();
  }

  unlock(password: string): Promise<UnlockResult> {
    this.unlockPasswords.push(password);
    return Promise.resolve(this.unlockResult);
  }

  changePassword(_current: string, _next: string): Promise<boolean> {
    this.passwordChanges += 1;
    return Promise.resolve(true);
  }

  anchorPolicy(): 'usability' | 'hardened' {
    return 'usability';
  }

  setAnchorPolicy(_password: string, _policy: 'usability' | 'hardened'): Promise<boolean> {
    this.anchorPolicyChanges += 1;
    return Promise.resolve(true);
  }

  recover(_input: ConfigureAppLockInput): Promise<void> {
    this.recoveries += 1;
    return Promise.resolve();
  }

  remove(_password: string): Promise<boolean> {
    this.removals += 1;
    return Promise.resolve(true);
  }
}

class FakeTouchId {
  statusValue: TouchIdStatus = { available: true, reason: null, enabled: true, reenrollmentRequired: false };
  enableValue: TouchIdEnableResult = { ok: true };
  unlockValue: TouchIdUnlockResult = { ok: true, masterKey: Buffer.alloc(32, 8) };
  credentialChanges = 0;
  disables = 0;
  enables = 0;

  status(): Promise<TouchIdStatus> {
    return Promise.resolve(this.statusValue);
  }

  enable(_password: string): Promise<TouchIdEnableResult> {
    this.enables += 1;
    return Promise.resolve(this.enableValue);
  }

  disable(): Promise<boolean> {
    this.disables += 1;
    this.statusValue = { ...this.statusValue, enabled: false };
    return Promise.resolve(true);
  }

  unlockMaster(): Promise<TouchIdUnlockResult> {
    return Promise.resolve(this.unlockValue);
  }

  credentialsChanged(): Promise<void> {
    this.credentialChanges += 1;
    this.statusValue = { ...this.statusValue, enabled: false };
    return Promise.resolve();
  }
}

describe('app-lock authority state machine (#311)', () => {
  test('configured startup stays closed until password custody releases the master', async () => {
    const credentials = new FakeCredentials();
    const opened: Buffer[] = [];
    const controller = new AppLockController({
      credentials,
      openAuthorized: (masterKey) => {
        if (masterKey !== undefined) opened.push(Buffer.from(masterKey));
      },
      closeAuthorized: () => undefined,
    });

    await controller.initialize();
    assert.deepEqual(opened, []);
    assert.throws(() => controller.requireContentAccess(), AppLockedError);
    assert.equal((await controller.unlock('password')).ok, true);
    assert.deepEqual(opened, [Buffer.alloc(32, 7)]);
    assert.equal(controller.snapshot().state, 'unlocked');
    controller.requireContentAccess();
  });

  test('wrong password stays locked and never opens services', async () => {
    const credentials = new FakeCredentials();
    credentials.unlockResult = { ok: false, reason: 'wrong-password' };
    let opened = false;
    const controller = new AppLockController({
      credentials,
      openAuthorized: () => {
        opened = true;
      },
      closeAuthorized: () => undefined,
    });
    assert.deepEqual(await controller.unlock('wrong'), { ok: false, reason: 'wrong-password' });
    assert.equal(opened, false);
    assert.equal(controller.snapshot().state, 'locked');
  });

  test('three incorrect passwords enter explicit recovery while preserving the retry count', async () => {
    const credentials = new FakeCredentials();
    credentials.unlockResult = { ok: false, reason: 'wrong-password' };
    let failures = 0;
    const controller = new AppLockController({
      credentials,
      openAuthorized: () => undefined,
      closeAuthorized: () => undefined,
      throttle: {
        remainingMs: () => 0,
        recordFailure: () => {
          failures += 1;
          return 0;
        },
        reset: () => {
          failures = 0;
        },
        failureCount: () => failures,
        attemptsRemaining: (limit = 3) => Math.max(0, limit - failures),
      },
    });

    assert.deepEqual(await controller.unlock('wrong-1'), { ok: false, reason: 'wrong-password', retryAfterMs: 0, attemptsRemaining: 2 });
    assert.deepEqual(await controller.unlock('wrong-2'), { ok: false, reason: 'wrong-password', retryAfterMs: 0, attemptsRemaining: 1 });
    assert.deepEqual(await controller.unlock('wrong-3'), { ok: false, reason: 'wrong-password', retryAfterMs: 0, attemptsRemaining: 0 });
    assert.equal(controller.snapshot().state, 'recovery-required');
    assert.deepEqual(credentials.unlockPasswords, ['wrong-1', 'wrong-2', 'wrong-3']);
  });

  test('re-authentication verifies an unlocked app without reopening or changing lock state', async () => {
    const credentials = new FakeCredentials();
    let opens = 0;
    const controller = new AppLockController({
      credentials,
      openAuthorized: () => {
        opens += 1;
      },
      closeAuthorized: () => undefined,
    });
    assert.deepEqual(await controller.unlock('unlock-password'), { ok: true });
    credentials.unlockResult = { ok: true, masterKey: Buffer.alloc(32, 9) };

    assert.deepEqual(await controller.authorize('confirm-password'), { ok: true });
    assert.equal(controller.snapshot().state, 'unlocked');
    assert.equal(opens, 1);
    assert.deepEqual(credentials.unlockPasswords, ['unlock-password', 'confirm-password']);
  });

  test('failed re-authentication preserves the unlocked app while applying the failure result', async () => {
    const credentials = new FakeCredentials();
    const controller = new AppLockController({
      credentials,
      openAuthorized: () => undefined,
      closeAuthorized: () => undefined,
    });
    await controller.unlock('unlock-password');
    credentials.unlockResult = { ok: false, reason: 'wrong-password' };

    assert.deepEqual(await controller.authorize('wrong'), { ok: false, reason: 'wrong-password' });
    assert.equal(controller.snapshot().state, 'unlocked');
  });

  test('anchor-policy re-authentication shares the three-attempt recovery budget', async () => {
    const credentials = new FakeCredentials();
    let failures = 0;
    let closes = 0;
    const controller = new AppLockController({
      credentials,
      openAuthorized: () => undefined,
      closeAuthorized: () => {
        closes += 1;
      },
      throttle: {
        remainingMs: () => 0,
        recordFailure: () => {
          failures += 1;
          return 0;
        },
        reset: () => {
          failures = 0;
        },
        failureCount: () => failures,
        attemptsRemaining: (limit = 3) => Math.max(0, limit - failures),
      },
    });
    await controller.unlock('unlock-password');
    credentials.unlockResult = { ok: false, reason: 'wrong-password' };

    assert.equal(await controller.setAnchorPolicy('wrong-1', 'hardened'), false);
    assert.equal(await controller.setAnchorPolicy('wrong-2', 'hardened'), false);
    assert.equal(await controller.setAnchorPolicy('wrong-3', 'hardened'), false);

    assert.equal(credentials.anchorPolicyChanges, 0);
    assert.equal(closes, 1);
    assert.equal(controller.snapshot().state, 'recovery-required');
    assert.deepEqual(credentials.unlockPasswords, ['unlock-password', 'wrong-1', 'wrong-2', 'wrong-3']);
  });

  test('settings password ceremonies share the three-attempt recovery budget', async () => {
    for (const ceremony of ['change-password', 'remove', 'touch-id'] as const) {
      const credentials = new FakeCredentials();
      const touchId = new FakeTouchId();
      let failures = 0;
      const controller = new AppLockController({
        credentials,
        touchId,
        openAuthorized: () => undefined,
        closeAuthorized: () => undefined,
        throttle: {
          remainingMs: () => 0,
          recordFailure: () => {
            failures += 1;
            return 0;
          },
          reset: () => {
            failures = 0;
          },
          failureCount: () => failures,
          attemptsRemaining: (limit = 3) => Math.max(0, limit - failures),
        },
      });
      await controller.unlock('unlock-password');
      credentials.unlockResult = { ok: false, reason: 'wrong-password' };

      for (const password of ['wrong-1', 'wrong-2', 'wrong-3']) {
        const accepted =
          ceremony === 'change-password'
            ? await controller.changePassword(password, 'next-password')
            : ceremony === 'remove'
              ? await controller.remove(password)
              : (await controller.enableTouchId(password)).ok;
        assert.equal(accepted, false);
      }

      assert.equal(controller.snapshot().state, 'recovery-required', ceremony);
      assert.equal(credentials.passwordChanges, 0, ceremony);
      assert.equal(credentials.removals, 0, ceremony);
      assert.equal(touchId.enables, 0, ceremony);
      assert.deepEqual(credentials.unlockPasswords, ['unlock-password', 'wrong-1', 'wrong-2', 'wrong-3'], ceremony);
    }
  });

  test('throttle write failure restores locked state after a wrong password', async () => {
    const credentials = new FakeCredentials();
    credentials.unlockResult = { ok: false, reason: 'wrong-password' };
    const controller = new AppLockController({
      credentials,
      openAuthorized: () => undefined,
      closeAuthorized: () => undefined,
      throttle: {
        remainingMs: () => 0,
        recordFailure: () => {
          throw new Error('keychain unavailable');
        },
        reset: () => undefined,
      },
    });

    await assert.rejects(controller.unlock('wrong'), /keychain unavailable/u);
    assert.equal(controller.snapshot().state, 'locked');
  });

  test('locking revokes admission before asynchronous cleanup finishes', async () => {
    const credentials = new FakeCredentials();
    let release: (() => void) | undefined;
    const closing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AppLockController({
      credentials,
      openAuthorized: () => undefined,
      closeAuthorized: () => closing,
    });
    await controller.unlock('password');

    const transition = controller.lock();
    await Promise.resolve();
    assert.equal(controller.snapshot().state, 'locking');
    assert.throws(() => controller.requireContentAccess(), AppLockedError);
    release?.();
    await transition;
    assert.equal(controller.snapshot().state, 'locked');
  });

  test('cleanup failure invokes fail-closed relaunch hook and remains locked', async () => {
    const credentials = new FakeCredentials();
    let failedClosed = false;
    const controller = new AppLockController({
      credentials,
      openAuthorized: () => undefined,
      closeAuthorized: () => Promise.reject(new Error('busy')),
      failClosed: () => {
        failedClosed = true;
      },
    });
    await controller.unlock('password');
    await controller.lock();
    assert.equal(failedClosed, true);
    assert.equal(controller.snapshot().state, 'locked');
  });

  test('throwing state listeners cannot interrupt custody transitions or other listeners', async () => {
    const credentials = new FakeCredentials();
    const observed: string[] = [];
    let closes = 0;
    const controller = new AppLockController({
      credentials,
      openAuthorized: () => undefined,
      closeAuthorized: () => {
        closes += 1;
      },
    });
    controller.subscribe(() => {
      throw new Error('observer failed');
    });
    controller.subscribe(({ state }) => observed.push(state));

    assert.deepEqual(await controller.unlock('password'), { ok: true });
    await controller.lock();

    assert.equal(closes, 1);
    assert.deepEqual(observed, ['unlocking', 'unlocked', 'locking', 'locked']);
    assert.equal(controller.snapshot().state, 'locked');
  });

  test('throttle reset failure cannot leave an opened library reported as locked', async () => {
    const credentials = new FakeCredentials();
    let opened = false;
    const controller = new AppLockController({
      credentials,
      openAuthorized: () => {
        opened = true;
      },
      closeAuthorized: () => undefined,
      throttle: {
        remainingMs: () => 0,
        recordFailure: () => 0,
        reset: () => {
          throw new Error('persistence unavailable');
        },
      },
    });

    assert.deepEqual(await controller.unlock('password'), { ok: false, reason: 'recovery-required' });
    assert.equal(opened, false);
    assert.equal(controller.snapshot().state, 'locked');
  });

  test('a post-password library lock conflict stays locked and never becomes recovery-required', async () => {
    const credentials = new FakeCredentials();
    const lockError = new Error('library is already open');
    const controller = new AppLockController({
      credentials,
      openAuthorized: () => {
        throw lockError;
      },
      closeAuthorized: () => undefined,
      classifyOpenError: (error) => (error === lockError ? 'library-in-use' : undefined),
    });

    assert.deepEqual(await controller.unlock('password'), { ok: false, reason: 'library-in-use' });
    assert.equal(controller.snapshot().state, 'locked');
  });

  test('legacy startup opens once and configuration closes into locked state', async () => {
    const credentials = new FakeCredentials();
    credentials.credentialStatus = { state: 'unconfigured' };
    let opens = 0;
    let closes = 0;
    const controller = new AppLockController({
      credentials,
      openAuthorized: () => {
        opens += 1;
      },
      closeAuthorized: () => {
        closes += 1;
      },
    });
    await controller.initialize();
    assert.equal(opens, 1);
    await controller.configure({ libraryId: 'library-a', password: 'Strong Password 1!', masterKey: Buffer.alloc(32, 3) });
    assert.equal(closes, 1);
    assert.equal(controller.snapshot().state, 'locked');
  });

  test('recovery cannot rewrite custody while an authorized library remains open', async () => {
    const credentials = new FakeCredentials();
    const controller = new AppLockController({
      credentials,
      openAuthorized: () => undefined,
      closeAuthorized: () => undefined,
    });
    await controller.unlock('password');

    await assert.rejects(
      controller.recover({ libraryId: 'library-a', password: 'Strong Password 1!', masterKey: Buffer.alloc(32, 3) }),
      AppLockedError,
    );
    assert.equal(credentials.recoveries, 0);
    assert.equal(controller.snapshot().state, 'unlocked');
  });

  test('successful recovery clears the persisted failed-attempt state', async () => {
    const credentials = new FakeCredentials();
    credentials.credentialStatus = { state: 'recovery-required', reason: 'anchor-missing' };
    let resets = 0;
    const controller = new AppLockController({
      credentials,
      openAuthorized: () => undefined,
      closeAuthorized: () => undefined,
      throttle: { remainingMs: () => 0, recordFailure: () => 0, reset: () => (resets += 1) },
    });

    await controller.recover({ libraryId: 'library-a', password: 'Strong Password 1!', masterKey: Buffer.alloc(32, 3) });
    assert.equal(resets, 1);
    assert.equal(controller.snapshot().state, 'locked');
  });
});

describe('Touch ID app-lock authority (#310)', () => {
  test('a post-biometric library lock conflict stays locked and never becomes recovery-required', async () => {
    const credentials = new FakeCredentials();
    const touchId = new FakeTouchId();
    const lockError = new Error('library is already open');
    const controller = new AppLockController({
      credentials,
      touchId,
      openAuthorized: () => {
        throw lockError;
      },
      closeAuthorized: () => undefined,
      classifyOpenError: (error) => (error === lockError ? 'library-in-use' : undefined),
    });

    assert.deepEqual(await controller.unlockWithTouchId(), { ok: false, reason: 'library-in-use' });
    assert.equal(controller.snapshot().state, 'locked');
  });
  test('successful biometric release opens M and resets the shared authentication throttle', async () => {
    const credentials = new FakeCredentials();
    const touchId = new FakeTouchId();
    const releasedMaster = Buffer.alloc(32, 8);
    touchId.unlockValue = { ok: true, masterKey: releasedMaster };
    const opened: Buffer[] = [];
    let throttleCalls = 0;
    const controller = new AppLockController({
      credentials,
      touchId,
      openAuthorized: (masterKey) => {
        if (masterKey !== undefined) opened.push(Buffer.from(masterKey));
      },
      closeAuthorized: () => undefined,
      throttle: {
        remainingMs: () => {
          throttleCalls += 1;
          return 0;
        },
        recordFailure: () => {
          throttleCalls += 1;
          return 60_000;
        },
        reset: () => {
          throttleCalls += 1;
        },
      },
    });

    assert.deepEqual(await controller.unlockWithTouchId(), { ok: true });
    assert.deepEqual(opened, [Buffer.alloc(32, 8)]);
    assert.deepEqual(releasedMaster, Buffer.alloc(32));
    assert.equal(throttleCalls, 2, 'one admission read and one reset');
    assert.equal(controller.snapshot().state, 'unlocked');
  });

  test('only a biometric nonmatch increments the shared authentication throttle', async () => {
    const credentials = new FakeCredentials();
    const touchId = new FakeTouchId();
    let throttleWrites = 0;
    const controller = new AppLockController({
      credentials,
      touchId,
      openAuthorized: () => undefined,
      closeAuthorized: () => undefined,
      throttle: {
        remainingMs: () => 0,
        recordFailure: () => {
          throttleWrites += 1;
          return 0;
        },
        reset: () => {
          throttleWrites += 1;
        },
      },
    });
    touchId.unlockValue = { ok: false, reason: 'cancelled' };
    assert.deepEqual(await controller.unlockWithTouchId(), { ok: false, reason: 'cancelled' });
    touchId.unlockValue = { ok: false, reason: 'failed' };
    assert.deepEqual(await controller.unlockWithTouchId(), { ok: false, reason: 'failed' });
    touchId.unlockMaster = () => Promise.reject(new Error('native boundary failed'));
    assert.deepEqual(await controller.unlockWithTouchId(), { ok: false, reason: 'unavailable' });
    assert.equal(controller.snapshot().state, 'locked');
    assert.equal(throttleWrites, 1);
    assert.deepEqual(await controller.unlock('password'), { ok: true }, 'password fallback remains authoritative');
  });

  test('biometric throttle write failure restores locked state', async () => {
    const credentials = new FakeCredentials();
    const touchId = new FakeTouchId();
    touchId.unlockValue = { ok: false, reason: 'failed' };
    const controller = new AppLockController({
      credentials,
      touchId,
      openAuthorized: () => undefined,
      closeAuthorized: () => undefined,
      throttle: {
        remainingMs: () => 0,
        recordFailure: () => {
          throw new Error('keychain unavailable');
        },
        reset: () => undefined,
      },
    });

    await assert.rejects(controller.unlockWithTouchId(), /keychain unavailable/u);
    assert.equal(controller.snapshot().state, 'locked');
  });

  test('opt-in requires an open library and opt-out publishes the resulting status', async () => {
    const credentials = new FakeCredentials();
    const touchId = new FakeTouchId();
    touchId.statusValue = { available: true, reason: null, enabled: false, reenrollmentRequired: false };
    const statuses: TouchIdStatus[] = [];
    const controller = new AppLockController({
      credentials,
      touchId,
      openAuthorized: () => undefined,
      closeAuthorized: () => undefined,
    });
    await assert.rejects(controller.enableTouchId('password'), AppLockedError);
    await controller.unlock('password');
    controller.subscribeTouchId((status) => statuses.push(status));
    assert.deepEqual(await controller.enableTouchId('password'), { ok: true });
    touchId.statusValue = { available: true, reason: null, enabled: true, reenrollmentRequired: false };
    assert.equal(await controller.disableTouchId(), true);
    assert.equal(touchId.disables, 1);
    assert.deepEqual(statuses.at(-1), { available: true, reason: null, enabled: false, reenrollmentRequired: false });
  });

  test('password rotation, removal, and recovery revoke old biometric custody', async () => {
    const credentials = new FakeCredentials();
    const touchId = new FakeTouchId();
    const controller = new AppLockController({
      credentials,
      touchId,
      openAuthorized: () => undefined,
      closeAuthorized: () => undefined,
    });
    await controller.unlock('password');
    assert.equal(await controller.changePassword('current', 'next'), true);
    assert.equal(await controller.remove('current'), true);
    assert.equal(touchId.credentialChanges, 2);

    const recoveryTouchId = new FakeTouchId();
    const recoveryController = new AppLockController({
      credentials: new FakeCredentials(),
      touchId: recoveryTouchId,
      openAuthorized: () => undefined,
      closeAuthorized: () => undefined,
    });
    await recoveryController.recover({ libraryId: 'library-a', password: 'Strong Password 1!', masterKey: Buffer.alloc(32, 3) });
    assert.equal(recoveryTouchId.credentialChanges, 1);
  });
});
