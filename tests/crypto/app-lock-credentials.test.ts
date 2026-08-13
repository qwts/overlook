import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { AppLockCredentialStore, type CredentialAnchor, type CredentialAnchorStore } from '../../src/main/crypto/app-lock-credentials.js';
import type { SafeStorageLike } from '../../src/main/crypto/keystore.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'overlook-app-lock-'));
}

function fakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(`sealed:${plainText}`, 'utf8'),
    decryptString: (encrypted) => encrypted.toString('utf8').replace(/^sealed:/, ''),
  };
}

class FakeAnchorStore implements CredentialAnchorStore {
  anchor: CredentialAnchor | null = null;
  failWrite = false;
  failAfterWrite = false;
  failClear = false;
  available = true;

  isAvailable(): boolean {
    return this.available;
  }

  read(): CredentialAnchor | null {
    return this.anchor;
  }

  write(anchor: CredentialAnchor): void {
    if (this.failWrite) throw new Error('anchor unavailable');
    this.anchor = structuredClone(anchor);
    if (this.failAfterWrite) throw new Error('anchor result was interrupted');
  }

  clear(): void {
    if (this.failClear) throw new Error('anchor clear was interrupted');
    this.anchor = null;
  }
}

function world(): {
  dataDir: string;
  masterKey: Buffer;
  anchors: FakeAnchorStore;
  store: AppLockCredentialStore;
} {
  const dataDir = tempDir();
  const masterKey = randomBytes(32);
  const anchors = new FakeAnchorStore();
  writeFileSync(join(dataDir, 'master.key'), fakeSafeStorage().encryptString(masterKey.toString('base64')));
  return {
    dataDir,
    masterKey,
    anchors,
    store: new AppLockCredentialStore({ dataDir, anchorStore: anchors, safeStorage: fakeSafeStorage() }),
  };
}

describe('app-lock credential custody (#311, ADR-0013)', () => {
  test('anchor failure cannot commit a configured record over live legacy custody', async () => {
    const { dataDir, anchors, store, masterKey } = world();
    anchors.failWrite = true;
    await assert.rejects(
      store.configure({ libraryId: 'library-a', password: 'correct horse battery staple', masterKey }),
      /anchor unavailable/,
    );
    assert.notEqual(readFileSync(join(dataDir, 'master.key')).subarray(0, 4).toString('ascii'), 'OVLK');
    assert.deepEqual(store.status(), { state: 'unconfigured' });
  });

  test('startup finishes the exact pending record when anchor commit succeeded before a crash', async () => {
    const { dataDir, anchors, store, masterKey } = world();
    anchors.failAfterWrite = true;
    await assert.rejects(store.configure({ libraryId: 'library-a', password: 'correct horse battery staple', masterKey }), /interrupted/);
    anchors.failAfterWrite = false;
    const restarted = new AppLockCredentialStore({ dataDir, anchorStore: anchors, safeStorage: fakeSafeStorage() });
    assert.deepEqual(restarted.status(), { state: 'locked', libraryId: 'library-a' });
    assert.equal((await restarted.unlock('correct horse battery staple')).ok, true);
  });

  test('missing committed custody never falls back to an unconfigured profile', async () => {
    const { dataDir, store, masterKey } = world();
    await store.configure({ libraryId: 'library-a', password: 'correct horse battery staple', masterKey });
    unlinkSync(join(dataDir, 'master.key'));

    assert.deepEqual(store.status(), { state: 'recovery-required', reason: 'anchor-mismatch' });
  });

  test('legacy custody rollback cannot bypass a previously configured lock', async () => {
    const { dataDir, anchors, store, masterKey } = world();
    const legacy = readFileSync(join(dataDir, 'master.key'));
    await store.configure({ libraryId: 'library-a', password: 'correct horse battery staple', masterKey });

    writeFileSync(join(dataDir, 'master.key'), legacy);
    anchors.clear();
    assert.deepEqual(store.status(), { state: 'recovery-required', reason: 'anchor-missing' });

    anchors.available = false;
    assert.deepEqual(store.status(), { state: 'recovery-required', reason: 'anchor-unavailable' });
  });

  test('startup promotes an anchored pending record even when committed custody is missing', async () => {
    const { dataDir, anchors, store, masterKey } = world();
    anchors.failAfterWrite = true;
    await assert.rejects(store.configure({ libraryId: 'library-a', password: 'correct horse battery staple', masterKey }), /interrupted/);
    unlinkSync(join(dataDir, 'master.key'));

    anchors.failAfterWrite = false;
    const restarted = new AppLockCredentialStore({ dataDir, anchorStore: anchors, safeStorage: fakeSafeStorage() });
    assert.deepEqual(restarted.status(), { state: 'locked', libraryId: 'library-a' });
    assert.equal((await restarted.unlock('correct horse battery staple')).ok, true);
  });

  test('creation rejects weak credentials in the main process', async () => {
    const { store, masterKey } = world();
    await assert.rejects(store.configure({ libraryId: 'library-a', password: 'password', masterKey }), /too weak/);
  });

  test('configure withholds the master behind password and unlock key slots', async () => {
    const { dataDir, masterKey, store } = world();
    await store.configure({ libraryId: 'library-a', password: 'correct horse battery staple', masterKey });

    const raw = readFileSync(join(dataDir, 'master.key'));
    assert.equal(raw.subarray(0, 4).toString('ascii'), 'OVLK');
    assert.equal(raw.includes(masterKey), false);
    assert.equal(raw.includes(Buffer.from('correct horse battery staple')), false);
    assert.deepEqual(store.status(), { state: 'locked', libraryId: 'library-a' });

    assert.deepEqual(await store.unlock('wrong password'), { ok: false, reason: 'wrong-password' });
    const released = await store.releaseUnlockKey('correct horse battery staple');
    assert.equal(released.ok, true);
    if (released.ok) {
      assert.equal(released.unlockKey.length, 32);
      assert.equal(released.unlockKey.equals(masterKey), false, 'password and biometric authority release U, never M');
      const throughReleasedKey = store.unlockWithKey(released.unlockKey);
      assert.equal(throughReleasedKey.ok, true);
      if (throughReleasedKey.ok) assert.deepEqual(throughReleasedKey.masterKey, masterKey);
      released.unlockKey.fill(0);
    }
    assert.deepEqual(store.unlockWithKey(Buffer.alloc(32)), { ok: false, reason: 'invalid-unlock-key' });
    const unlocked = await store.unlock('correct horse battery staple');
    assert.equal(unlocked.ok, true);
    if (unlocked.ok) assert.deepEqual(unlocked.masterKey, masterKey);
  });

  test('malformed records fail closed while usability policy repairs anchors only after authentication', async () => {
    const { dataDir, anchors, store, masterKey } = world();
    await store.configure({ libraryId: 'library-a', password: 'correct horse battery staple', masterKey });
    const path = join(dataDir, 'master.key');
    const raw = readFileSync(path);
    const tampered = Buffer.from(raw);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    writeFileSync(path, tampered);
    assert.deepEqual(store.status(), { state: 'recovery-required', reason: 'invalid-record' });

    writeFileSync(path, raw);
    anchors.clear();
    assert.deepEqual(store.status(), { state: 'locked', libraryId: 'library-a' });
    assert.deepEqual(await store.unlock('wrong password'), { ok: false, reason: 'wrong-password' });
    assert.equal(anchors.anchor, null, 'wrong credentials never repair trust state');
    assert.equal((await store.unlock('correct horse battery staple')).ok, true);
    assert.deepEqual(anchors.anchor, store.recordAnchor());

    anchors.write({ libraryId: 'library-a', generation: 0, recordHash: '0'.repeat(64) });
    assert.deepEqual(store.status(), { state: 'locked', libraryId: 'library-a' });
    assert.equal((await store.unlock('correct horse battery staple')).ok, true);
    assert.deepEqual(anchors.anchor, store.recordAnchor());
  });

  test('hardened policy is authenticated and requires recovery after anchor loss', async () => {
    const { anchors, store, masterKey } = world();
    const password = 'correct horse battery staple';
    await store.configure({ libraryId: 'library-a', password, masterKey });

    assert.equal(store.anchorPolicy(), 'usability');
    assert.equal(await store.setAnchorPolicy('wrong password', 'hardened'), false);
    assert.equal(store.anchorPolicy(), 'usability');
    assert.equal(await store.setAnchorPolicy(password, 'hardened'), true);
    assert.equal(store.anchorPolicy(), 'hardened');

    anchors.clear();
    assert.deepEqual(store.status(), { state: 'recovery-required', reason: 'anchor-missing' });
    assert.deepEqual(await store.unlock(password), { ok: false, reason: 'recovery-required' });
  });

  test('valid credentials report unavailable storage separately when usability repair cannot persist', async () => {
    const { anchors, store, masterKey } = world();
    const password = 'correct horse battery staple';
    await store.configure({ libraryId: 'library-a', password, masterKey });
    anchors.clear();
    anchors.available = false;

    assert.deepEqual(store.status(), { state: 'locked', libraryId: 'library-a' });
    assert.deepEqual(await store.unlock(password), { ok: false, reason: 'storage-unavailable' });
  });

  test('password change rotates custody and revokes the old password', async () => {
    const { store, masterKey } = world();
    await store.configure({ libraryId: 'library-a', password: 'correct horse battery staple', masterKey });
    const firstAnchor = store.anchor();

    assert.equal(await store.changePassword('correct horse battery staple', 'a different excellent password'), true);
    assert.equal((await store.unlock('correct horse battery staple')).ok, false);
    const unlocked = await store.unlock('a different excellent password');
    assert.equal(unlocked.ok, true);
    if (unlocked.ok) assert.deepEqual(unlocked.masterKey, masterKey);
    assert.equal(store.anchor()?.generation, (firstAnchor?.generation ?? 0) + 1);
  });

  test('startup resumes an interrupted password rotation without accepting the old record', async () => {
    const { dataDir, anchors, store, masterKey } = world();
    const oldPassword = 'correct horse battery staple';
    const nextPassword = 'a different excellent password';
    await store.configure({ libraryId: 'library-a', password: oldPassword, masterKey });
    anchors.failAfterWrite = true;
    await assert.rejects(store.changePassword(oldPassword, nextPassword), /interrupted/);

    anchors.failAfterWrite = false;
    const restarted = new AppLockCredentialStore({ dataDir, anchorStore: anchors, safeStorage: fakeSafeStorage() });
    assert.deepEqual(restarted.status(), { state: 'locked', libraryId: 'library-a' });
    assert.equal((await restarted.unlock(oldPassword)).ok, false);
    assert.equal((await restarted.unlock(nextPassword)).ok, true);
  });

  test('recovery establishes new custody and remove restores legacy safeStorage custody', async () => {
    const { dataDir, anchors, store, masterKey } = world();
    await store.configure({ libraryId: 'library-a', password: 'correct horse battery staple', masterKey });

    const replacementPassword = 'replacement password with enough strength';
    await store.recover({ libraryId: 'library-a', password: replacementPassword, masterKey });
    assert.equal((await store.unlock('correct horse battery staple')).ok, false);
    assert.equal((await store.unlock(replacementPassword)).ok, true);

    assert.equal(await store.remove(replacementPassword), true);
    assert.deepEqual(store.status(), { state: 'unconfigured' });
    assert.equal(anchors.anchor, null);
    assert.equal(existsSync(join(dataDir, 'app-lock.configured')), false);
    const restored = Buffer.from(fakeSafeStorage().decryptString(readFileSync(join(dataDir, 'master.key'))), 'base64');
    assert.deepEqual(restored, masterKey);
  });

  test('startup completes an authorized removal interrupted after the legacy record commit', async () => {
    const { dataDir, anchors, store, masterKey } = world();
    const password = 'correct horse battery staple';
    await store.configure({ libraryId: 'library-a', password, masterKey });
    anchors.failClear = true;
    await assert.rejects(store.remove(password), /interrupted/);

    anchors.failClear = false;
    const restarted = new AppLockCredentialStore({ dataDir, anchorStore: anchors, safeStorage: fakeSafeStorage() });
    assert.deepEqual(restarted.status(), { state: 'unconfigured' });
    assert.equal(anchors.anchor, null);
    const restored = Buffer.from(fakeSafeStorage().decryptString(readFileSync(join(dataDir, 'master.key'))), 'base64');
    assert.deepEqual(restored, masterKey);
  });
});

describe('restore custody re-establishment (#754)', () => {
  test('recover() over a restored keychain-form key + stale anchor yields a locked, unlockable record', async () => {
    // The exact post-restore state: installRecoveredMaster left the keychain
    // form on disk, and the replaced library's anchor is still in the OS
    // credential store. recover() must land the password-derived record with
    // a matching anchor in one two-phase commit.
    const { dataDir, anchors, store, masterKey } = world();
    anchors.anchor = { libraryId: 'library-a', generation: 7, recordHash: 'stale-hash-from-replaced-library' };
    const password = 'correct horse battery staple';
    await store.recover({ libraryId: 'library-a', password, masterKey });

    const restarted = new AppLockCredentialStore({ dataDir, anchorStore: anchors, safeStorage: fakeSafeStorage() });
    assert.deepEqual(restarted.status(), { state: 'locked', libraryId: 'library-a' });
    const unlocked = await restarted.unlock(password);
    assert.equal(unlocked.ok, true);
    if (unlocked.ok) {
      assert.deepEqual(unlocked.masterKey, masterKey);
      unlocked.masterKey.fill(0);
    }
    assert.ok((anchors.anchor?.generation ?? 0) > 7, 'the stale anchor generation is superseded, never reused');
    assert.equal(readFileSync(join(dataDir, 'master.key')).subarray(0, 4).toString('ascii'), 'OVLK');
  });
});
