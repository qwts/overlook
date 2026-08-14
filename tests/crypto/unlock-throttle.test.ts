import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import type { SafeStorageLike } from '../../src/main/crypto/keystore.js';
import { UnlockThrottle } from '../../src/main/crypto/unlock-throttle.js';

const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(`sealed:${plainText}`, 'utf8'),
  decryptString: (encrypted) => {
    const value = encrypted.toString('utf8');
    if (!value.startsWith('sealed:')) throw new Error('corrupt');
    return value.slice('sealed:'.length);
  },
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'overlook-throttle-'));
}

describe('persisted unlock throttling (#311)', () => {
  test('failures back off 1–60 seconds across restart and success resets', () => {
    const dataDir = tempDir();
    let now = 10_000;
    const make = (): UnlockThrottle => new UnlockThrottle({ dataDir, safeStorage: storage, now: () => now });
    const throttle = make();
    assert.equal(throttle.remainingMs(), 0);
    assert.equal(throttle.attemptsRemaining(), 3);
    assert.equal(throttle.recordFailure(), 1_000);
    assert.equal(throttle.failureCount(), 1);
    assert.equal(throttle.attemptsRemaining(), 2);
    assert.equal(make().remainingMs(), 1_000);

    now += 1_000;
    assert.equal(make().remainingMs(), 0);
    assert.equal(make().recordFailure(), 2_000);
    assert.equal(make().attemptsRemaining(), 1);
    now += 2_000;
    for (const delay of [4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      assert.equal(make().recordFailure(), delay);
      now += delay;
    }

    assert.equal(make().recordFailure(), 60_000);
    assert.equal(make().attemptsRemaining(), 0);
    make().reset();
    assert.equal(make().remainingMs(), 0);
    assert.equal(make().attemptsRemaining(), 3);
  });

  test('corrupt sealed state fails closed to a persisted 60-second delay', () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, 'app-lock-throttle'), Buffer.from('not sealed'));
    const throttle = new UnlockThrottle({ dataDir, safeStorage: storage, now: () => 50_000 });
    assert.equal(throttle.remainingMs(), 60_000);
    assert.equal(throttle.remainingMs(), 60_000);
  });
});
