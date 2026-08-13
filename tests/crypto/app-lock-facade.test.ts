import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AppLockController } from '../../src/main/crypto/app-lock-controller.js';
import { createAppLockFacade } from '../../src/main/crypto/app-lock-facade.js';
import type { AppLockStatus, ConfigureAppLockInput, UnlockResult } from '../../src/main/crypto/app-lock-credentials.js';

class FacadeCredentials {
  statusValue: AppLockStatus = { state: 'unconfigured' };
  unlockValue: UnlockResult = { ok: true, masterKey: Buffer.alloc(32, 7) };
  configured: ConfigureAppLockInput | null = null;
  policy: 'usability' | 'hardened' = 'usability';

  status(): AppLockStatus {
    return this.statusValue;
  }

  configure(input: ConfigureAppLockInput): Promise<void> {
    this.configured = { ...input, masterKey: Buffer.from(input.masterKey) };
    return Promise.resolve();
  }

  unlock(_password: string): Promise<UnlockResult> {
    return Promise.resolve(this.unlockValue);
  }

  changePassword(current: string, next: string): Promise<boolean> {
    return Promise.resolve(current === 'current' && next === 'next');
  }

  remove(password: string): Promise<boolean> {
    return Promise.resolve(password === 'current');
  }

  recover(_input: ConfigureAppLockInput): Promise<void> {
    return Promise.resolve();
  }

  anchorPolicy(): 'usability' | 'hardened' {
    return this.policy;
  }

  setAnchorPolicy(password: string, policy: 'usability' | 'hardened'): Promise<boolean> {
    if (password !== 'current') return Promise.resolve(false);
    this.policy = policy;
    return Promise.resolve(true);
  }
}

describe('app-lock facade (#311)', () => {
  test('configuration passes a temporary master copy and always zeroizes it', async () => {
    const credentials = new FacadeCredentials();
    const masterKey = Buffer.alloc(32, 9);
    const controller = new AppLockController({ credentials, openAuthorized: () => undefined, closeAuthorized: () => undefined });
    const facade = createAppLockFacade({
      controller,
      currentMaster: () => masterKey,
      libraryId: () => 'library-a',
      dataDir: () => '/unused',
      pickRecovery: () => Promise.resolve('/recovery.key'),
    });

    assert.deepEqual(facade.snapshot(), { state: 'unconfigured-unlocked', libraryId: null });
    assert.equal(facade.retryAfterMs(), 0);
    assert.equal(await facade.pickRecovery(), '/recovery.key');
    await facade.configure('Strong Password 42!');
    assert.deepEqual(masterKey, Buffer.alloc(32));
    assert.deepEqual(credentials.configured?.masterKey, Buffer.alloc(32, 9));
    assert.deepEqual(facade.snapshot(), { state: 'locked', libraryId: 'library-a' });
  });

  test('delegates unlock, password rotation, removal, and manual lock to authority', async () => {
    const credentials = new FacadeCredentials();
    credentials.statusValue = { state: 'locked', libraryId: 'library-a' };
    const controller = new AppLockController({ credentials, openAuthorized: () => undefined, closeAuthorized: () => undefined });
    const facade = createAppLockFacade({
      controller,
      currentMaster: () => Buffer.alloc(32),
      libraryId: () => 'library-a',
      dataDir: () => '/unused',
      pickRecovery: () => Promise.resolve(null),
    });

    assert.deepEqual(await facade.unlock('current'), { ok: true });
    assert.deepEqual(await facade.changePassword('current', 'next'), { ok: true });
    assert.deepEqual(await facade.remove('current'), { ok: true });
    await facade.lock();
    assert.equal(facade.snapshot().state, 'unconfigured-unlocked');
  });

  test('requires and consumes a fresh recovery-export receipt before hardened policy', async () => {
    const credentials = new FacadeCredentials();
    credentials.statusValue = { state: 'locked', libraryId: 'library-a' };
    const controller = new AppLockController({ credentials, openAuthorized: () => undefined, closeAuthorized: () => undefined });
    await controller.unlock('current');
    let receipts = 1;
    const facade = createAppLockFacade({
      controller,
      currentMaster: () => Buffer.alloc(32),
      libraryId: () => 'library-a',
      dataDir: () => '/unused',
      pickRecovery: () => Promise.resolve(null),
      recoveryExportReceipt: (consume) => (consume ? receipts-- > 0 : receipts > 0),
    });

    assert.deepEqual(await facade.setAnchorPolicy('current', 'hardened', false), { ok: false, reason: null });
    assert.deepEqual(await facade.setAnchorPolicy('wrong', 'hardened', true), { ok: false, reason: 'wrong-password' });
    assert.deepEqual(await facade.setAnchorPolicy('current', 'hardened', true), { ok: true });
    assert.equal(facade.anchorPolicy(), 'hardened');
    assert.deepEqual(await facade.setAnchorPolicy('current', 'hardened', true), { ok: false, reason: null }, 'receipt is single-use');
  });
});
