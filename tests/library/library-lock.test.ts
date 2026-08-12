import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireLibraryLock,
  describeStartupLockHold,
  LibraryLockError,
  lockPath,
  readLockHolder,
  type LibraryLockRecord,
} from '../../src/main/library/library-lock.js';

// ADR-0017 §5 / #385: advisory per-library single-instance lock — O_EXCL
// acquire, same-host dead-pid reclaim, cross-host refusal, idempotent release.

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'overlook-lock-'));
}

describe('library lock (#385)', () => {
  test('acquire writes the record and release removes it', () => {
    const dir = tempDir();
    const release = acquireLibraryLock(dir, 'instance-a', { host: 'mac-a', pid: 100, isPidAlive: () => true });

    const record = JSON.parse(readFileSync(lockPath(dir), 'utf8')) as LibraryLockRecord;
    assert.equal(record.instanceId, 'instance-a');
    assert.equal(record.pid, 100);
    assert.equal(record.hostname, 'mac-a');

    release();
    assert.ok(!existsSync(lockPath(dir)), 'released lock is gone');
    release();
    assert.ok(!existsSync(lockPath(dir)), 'release is idempotent');
  });

  test('ACCEPTANCE: a second instance targeting an open library is refused with a clear error', () => {
    const dir = tempDir();
    acquireLibraryLock(dir, 'instance-a', { host: 'mac-a', pid: 100, isPidAlive: () => true });

    assert.throws(
      () => acquireLibraryLock(dir, 'instance-b', { host: 'mac-a', pid: 200, isPidAlive: () => true }),
      (error: unknown) => error instanceof LibraryLockError && error.reason === 'held-by-instance' && /already open/.test(error.message),
    );
  });

  test('a same-host lock with a dead pid is stale and reclaimed (crash recovery)', () => {
    const dir = tempDir();
    acquireLibraryLock(dir, 'instance-a', { host: 'mac-a', pid: 100, isPidAlive: () => true });

    const release = acquireLibraryLock(dir, 'instance-b', { host: 'mac-a', pid: 200, isPidAlive: (pid) => pid !== 100 });
    const record = JSON.parse(readFileSync(lockPath(dir), 'utf8')) as LibraryLockRecord;
    assert.equal(record.instanceId, 'instance-b', 'stale lock reclaimed by the new instance');
    release();
  });

  test('a live reused pid with a different process birth is stale and reclaimed', () => {
    const dir = tempDir();
    acquireLibraryLock(dir, 'instance-a', {
      host: 'mac-a',
      pid: 100,
      isPidAlive: () => true,
      processIdentity: () => 'old-birth',
    });
    const release = acquireLibraryLock(dir, 'instance-b', {
      host: 'mac-a',
      pid: 200,
      isPidAlive: () => true,
      processIdentity: (pid) => (pid === 100 ? 'reused-birth' : 'new-birth'),
    });
    assert.equal((JSON.parse(readFileSync(lockPath(dir), 'utf8')) as LibraryLockRecord).instanceId, 'instance-b');
    release();
  });

  test('a live pid with the recorded process birth remains a genuine holder', () => {
    const dir = tempDir();
    acquireLibraryLock(dir, 'instance-a', {
      host: 'mac-a',
      pid: 100,
      isPidAlive: () => true,
      processIdentity: () => 'same-birth',
    });
    assert.throws(
      () =>
        acquireLibraryLock(dir, 'instance-b', {
          host: 'mac-a',
          pid: 200,
          isPidAlive: () => true,
          processIdentity: () => 'same-birth',
        }),
      (error: unknown) => error instanceof LibraryLockError && error.reason === 'held-by-instance',
    );
  });

  test('the default process birth identity is stable across timezone changes', () => {
    const dir = tempDir();
    const previous = process.env['TZ'];
    try {
      process.env['TZ'] = 'UTC';
      acquireLibraryLock(dir, 'instance-a');
      process.env['TZ'] = 'America/Los_Angeles';
      assert.throws(
        () => acquireLibraryLock(dir, 'instance-b'),
        (error: unknown) => error instanceof LibraryLockError && error.reason === 'held-by-instance',
      );
    } finally {
      if (previous === undefined) delete process.env['TZ'];
      else process.env['TZ'] = previous;
    }
  });

  test('a lock from another machine refuses — liveness cannot be verified across machines', () => {
    const dir = tempDir();
    acquireLibraryLock(dir, 'instance-a', { host: 'mac-a', pid: 100, machineId: 'machine-a', isPidAlive: () => true });

    assert.throws(
      () => acquireLibraryLock(dir, 'instance-b', { host: 'mac-b', pid: 100, machineId: 'machine-b', isPidAlive: () => false }),
      (error: unknown) => error instanceof LibraryLockError && error.reason === 'held-by-other-host' && /mac-a/.test(error.message),
    );
  });

  test('ACCEPTANCE (#842): a crashed lock survives hostname drift — same machine id + dead pid reclaims', () => {
    const dir = tempDir();
    // The incident shape: crash leaves the lock, a router outage renames the
    // host (.local → .lan) before relaunch. Same machine, so staleness must
    // still be judged by pid liveness.
    acquireLibraryLock(dir, 'crashed', { host: 'MacMiniM2.local', pid: 100, machineId: 'machine-a', isPidAlive: () => true });

    const release = acquireLibraryLock(dir, 'instance-b', {
      host: 'macminim2.lan',
      pid: 200,
      machineId: 'machine-a',
      isPidAlive: (pid) => pid !== 100,
    });
    const record = JSON.parse(readFileSync(lockPath(dir), 'utf8')) as LibraryLockRecord;
    assert.equal(record.instanceId, 'instance-b', 'stale same-machine lock reclaimed despite hostname drift');
    assert.equal(record.machineId, 'machine-a', 'fresh record carries the machine id');
    release();
  });

  test('#842: hostname drift with a LIVE same-machine holder still refuses held-by-instance', () => {
    const dir = tempDir();
    acquireLibraryLock(dir, 'instance-a', { host: 'MacMiniM2.local', pid: 100, machineId: 'machine-a', isPidAlive: () => true });

    assert.throws(
      () => acquireLibraryLock(dir, 'instance-b', { host: 'macminim2.lan', pid: 200, machineId: 'machine-a', isPidAlive: () => true }),
      (error: unknown) => error instanceof LibraryLockError && error.reason === 'held-by-instance',
    );
  });

  test('#842: identical hostnames on DIFFERENT machines refuse — machine id outranks hostname collision', () => {
    const dir = tempDir();
    acquireLibraryLock(dir, 'instance-a', { host: 'mac', pid: 100, machineId: 'machine-a', isPidAlive: () => true });

    assert.throws(
      // Before machine ids, a colliding hostname allowed a bogus pid-liveness
      // reclaim across machines; now the ids decide.
      () => acquireLibraryLock(dir, 'instance-b', { host: 'mac', pid: 100, machineId: 'machine-b', isPidAlive: () => false }),
      (error: unknown) => error instanceof LibraryLockError && error.reason === 'held-by-other-host',
    );
  });

  test('#842: legacy record without a machine id keeps the conservative hostname judgment', () => {
    const dir = tempDir();
    writeFileSync(lockPath(dir), JSON.stringify({ instanceId: 'old', pid: 100, hostname: 'mac-a', acquiredAt: 'x' }), 'utf8');

    // Different hostname → refuse, even though this process has a machine id.
    assert.throws(
      () => acquireLibraryLock(dir, 'instance-b', { host: 'mac-b', pid: 200, machineId: 'machine-b', isPidAlive: () => false }),
      (error: unknown) => error instanceof LibraryLockError && error.reason === 'held-by-other-host',
    );
    // Same hostname + dead pid → stale, reclaimed as before.
    const release = acquireLibraryLock(dir, 'instance-b', { host: 'mac-a', pid: 200, machineId: 'machine-b', isPidAlive: () => false });
    release();
  });

  test('#842: a record WITH a machine id where the local probe fails falls back to hostname', () => {
    const dir = tempDir();
    acquireLibraryLock(dir, 'instance-a', { host: 'mac-a', pid: 100, machineId: 'machine-a', isPidAlive: () => true });

    // machineId: null = probe unavailable. Hostname differs → conservative refusal.
    assert.throws(
      () => acquireLibraryLock(dir, 'instance-b', { host: 'mac-b', pid: 200, machineId: null, isPidAlive: () => false }),
      (error: unknown) => error instanceof LibraryLockError && error.reason === 'held-by-other-host',
    );
  });

  test('a torn/garbage lock file never wedges the library', () => {
    const dir = tempDir();
    writeFileSync(lockPath(dir), '{ half-written', 'utf8');

    const release = acquireLibraryLock(dir, 'instance-a', { host: 'mac-a', pid: 100, isPidAlive: () => true });
    assert.equal((JSON.parse(readFileSync(lockPath(dir), 'utf8')) as LibraryLockRecord).instanceId, 'instance-a');
    release();
  });

  test('release does not remove a lock re-acquired by someone else', () => {
    const dir = tempDir();
    const releaseA = acquireLibraryLock(dir, 'instance-a', { host: 'mac-a', pid: 100, isPidAlive: () => true });
    releaseA();
    acquireLibraryLock(dir, 'instance-b', { host: 'mac-a', pid: 200, isPidAlive: () => true });

    releaseA();
    assert.equal(
      (JSON.parse(readFileSync(lockPath(dir), 'utf8')) as LibraryLockRecord).instanceId,
      'instance-b',
      "instance A's stale release left B's lock intact",
    );
  });

  test('re-acquire by the same instance replaces its own record (relaunch after crash where pid changed)', () => {
    const dir = tempDir();
    acquireLibraryLock(dir, 'instance-a', { host: 'mac-a', pid: 100, isPidAlive: () => false });
    const release = acquireLibraryLock(dir, 'instance-a', { host: 'mac-a', pid: 101, isPidAlive: () => false });
    assert.equal((JSON.parse(readFileSync(lockPath(dir), 'utf8')) as LibraryLockRecord).pid, 101);
    release();
  });

  test('REGRESSION (PR #425): a racer with a stale view cannot delete a fresh lock written after reclaim', () => {
    const dir = tempDir();
    // Both A and B judged the crashed lock stale; A reclaimed and wrote its
    // fresh lock. B's reclaim must leave A's lock alone, and B's own write
    // must then fail against it.
    acquireLibraryLock(dir, 'crashed', { host: 'mac-a', pid: 100, isPidAlive: () => true });
    const releaseA = acquireLibraryLock(dir, 'instance-a', { host: 'mac-a', pid: 200, isPidAlive: (pid) => pid !== 100 });

    assert.throws(
      // B arrives now: the on-disk lock is A's FRESH record with a live pid —
      // refused at the liveness check, and even a hypothetical stale-view
      // deletion is guarded by the content re-check inside reclaim.
      () => acquireLibraryLock(dir, 'instance-b', { host: 'mac-a', pid: 300, isPidAlive: (pid) => pid !== 100 }),
      (error: unknown) => error instanceof LibraryLockError && error.reason === 'held-by-instance',
    );
    assert.equal(
      (JSON.parse(readFileSync(lockPath(dir), 'utf8')) as LibraryLockRecord).instanceId,
      'instance-a',
      "A's fresh lock survived B",
    );
    releaseA();
  });

  test('REGRESSION (PR #425): a live reclaim guard refuses concurrent reclaimers; an abandoned one is swept', () => {
    const dir = tempDir();
    // A crashed holder plus a guard someone is actively holding: refuse.
    writeFileSync(lockPath(dir), JSON.stringify({ instanceId: 'crashed', pid: 100, hostname: 'mac-a', acquiredAt: 'x' }), 'utf8');
    writeFileSync(`${lockPath(dir)}.reclaim`, '', 'utf8');
    assert.throws(
      () => acquireLibraryLock(dir, 'instance-b', { host: 'mac-a', pid: 300, isPidAlive: () => false }),
      (error: unknown) => error instanceof LibraryLockError && /being opened/.test(error.message),
    );

    // The same guard abandoned by a crash (old mtime): swept, reclaim wins.
    const future = new Date(Date.now() + 60_000);
    const release = acquireLibraryLock(dir, 'instance-b', { host: 'mac-a', pid: 300, isPidAlive: () => false, now: () => future });
    assert.ok(!existsSync(`${lockPath(dir)}.reclaim`), 'guard cleaned up');
    release();
  });

  test('readLockHolder (#386): names a live foreign holder, stays quiet for free/own/stale locks', () => {
    const dir = tempDir();
    assert.equal(readLockHolder(dir, 'me', { host: 'mac-a' }), null, 'no lock file — free');

    acquireLibraryLock(dir, 'me', { host: 'mac-a', pid: 100, isPidAlive: () => true });
    assert.equal(readLockHolder(dir, 'me', { host: 'mac-a' }), null, 'our own lock is not "elsewhere"');

    assert.equal(readLockHolder(dir, 'other', { host: 'mac-a', isPidAlive: () => true }), 'mac-a', 'live same-host holder is named');
    assert.equal(
      readLockHolder(dir, 'other', { host: 'mac-a', isPidAlive: () => false }),
      null,
      'dead same-host holder is stale, not locked',
    );
    assert.equal(
      readLockHolder(dir, 'other', { host: 'mac-b', machineId: null, isPidAlive: () => false }),
      'mac-a',
      'cross-host counts as live — liveness is unverifiable',
    );
  });

  test('describeStartupLockHold (#842): names a live foreign holder, silent when openable', () => {
    const dir = tempDir();
    assert.equal(describeStartupLockHold(dir, 'Home Library', 'me', { host: 'mac-a' }), null, 'no lock — openable');

    acquireLibraryLock(dir, 'holder', { host: 'mac-a', pid: 100, machineId: 'machine-a', isPidAlive: () => true });
    const message = describeStartupLockHold(dir, 'Home Library', 'other', {
      host: 'mac-b',
      machineId: 'machine-b',
      isPidAlive: () => false,
    });
    assert.ok(message !== null && /Home Library/.test(message) && /mac-a/.test(message), 'names the library and the holder');

    assert.equal(
      describeStartupLockHold(dir, 'Home Library', 'other', { host: 'mac-b', machineId: 'machine-a', isPidAlive: () => false }),
      null,
      'same machine + dead pid is reclaimable — no loud dialog',
    );
  });

  test('readLockHolder (#842): machine id judgment matches acquire', () => {
    const dir = tempDir();
    acquireLibraryLock(dir, 'holder', { host: 'MacMiniM2.local', pid: 100, machineId: 'machine-a', isPidAlive: () => true });

    assert.equal(
      readLockHolder(dir, 'other', { host: 'macminim2.lan', machineId: 'machine-a', isPidAlive: () => false }),
      null,
      'hostname drift + same machine + dead pid is stale, not locked',
    );
    assert.equal(
      readLockHolder(dir, 'other', { host: 'MacMiniM2.local', machineId: 'machine-b', isPidAlive: () => false }),
      'MacMiniM2.local',
      'different machine is named even when hostnames collide',
    );
  });

  test('the default pid-liveness probe: our own pid is alive, an absurd pid is not', () => {
    const dir = tempDir();
    // Held by THIS process on the real host: refused via the real probe.
    acquireLibraryLock(dir, 'instance-a', { pid: process.pid });
    assert.throws(() => acquireLibraryLock(dir, 'instance-b', {}), LibraryLockError);
    const host = (JSON.parse(readFileSync(lockPath(dir), 'utf8')) as LibraryLockRecord).hostname;

    // Held by a pid that cannot exist: stale, reclaimed via the real probe.
    const dir2 = tempDir();
    writeFileSync(lockPath(dir2), JSON.stringify({ instanceId: 'ghost', pid: 2 ** 30, hostname: host, acquiredAt: 'x' }), 'utf8');
    const release = acquireLibraryLock(dir2, 'instance-b', {});
    release();
  });
});
