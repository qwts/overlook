import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { createDecryptStream, createEncryptStream } from '../../src/main/crypto/envelope.js';
import { KeyCustodyError, KeyStore, probeMasterUnwrap, type SafeStorageLike } from '../../src/main/crypto/keystore.js';

// Deterministic fake keychain: XORs with a fixed pad so "wrapped" bytes are
// not the plaintext, and a second fake with a different pad simulates a
// different OS account (unwrap must fail loudly).
function fakeSafeStorage(pad: number, available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ pad)),
    decryptString: (encrypted) => Buffer.from(encrypted.map((byte) => byte ^ pad)).toString('utf8'),
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'overlook-keystore-'));
}

describe('KeyStore lifecycle', () => {
  test('first run creates a master key and KEY #1', () => {
    const dataDir = tempDir();
    const store = KeyStore.open({ safeStorage: fakeSafeStorage(0x5a), dataDir });
    assert.equal(store.currentKey().id, 1);
    assert.equal(store.currentKey().key.length, 32);
    assert.deepEqual(
      store.listKeys().map((key) => ({ id: key.id, status: key.status })),
      [{ id: 1, status: 'active' }],
    );
  });

  test('restart persistence: a fresh open on the same dir yields the same keys', () => {
    const dataDir = tempDir();
    const safeStorage = fakeSafeStorage(0x5a);
    const first = KeyStore.open({ safeStorage, dataDir });
    const keyBefore = first.currentKey();

    const reopened = KeyStore.open({ safeStorage, dataDir });
    const keyAfter = reopened.currentKey();
    assert.equal(keyAfter.id, keyBefore.id);
    assert.deepEqual(keyAfter.key, keyBefore.key);
  });

  test('reserves deterministic nonce prefixes without reuse across restart', () => {
    const dataDir = tempDir();
    const safeStorage = fakeSafeStorage(0x5a);
    const first = KeyStore.open({ safeStorage, dataDir });
    const reserveFirst = first.currentKey().reserveNoncePrefix;
    assert.ok(reserveFirst !== undefined);
    assert.equal(reserveFirst().readBigUInt64BE(), 0n);
    assert.equal(reserveFirst().readBigUInt64BE(), 1n);
    const reserved = JSON.parse(readFileSync(join(dataDir, 'keys.json'), 'utf8')) as {
      keys: { nonceHighWater: string }[];
    };
    assert.equal(reserved.keys[0]?.nonceHighWater, '1024');

    const reopened = KeyStore.open({ safeStorage, dataDir });
    const reserveReopened = reopened.currentKey().reserveNoncePrefix;
    assert.ok(reserveReopened !== undefined);
    assert.ok(reserveReopened().readBigUInt64BE() > 1n);
  });

  test('does not advance the in-memory reservation when persistence fails', () => {
    const dataDir = tempDir();
    const store = KeyStore.open({ safeStorage: fakeSafeStorage(0x5a), dataDir });
    const reserve = store.currentKey().reserveNoncePrefix;
    assert.ok(reserve !== undefined);
    const temporaryKeysPath = join(dataDir, 'keys.json.tmp');
    mkdirSync(temporaryKeysPath);

    assert.throws(() => reserve(), /EISDIR|directory/u);
    rmSync(temporaryKeysPath, { recursive: true });
    assert.equal(reserve().readBigUInt64BE(), 0n);
    const persisted = JSON.parse(readFileSync(join(dataDir, 'keys.json'), 'utf8')) as {
      keys: { nonceHighWater: string }[];
    };
    assert.equal(persisted.keys[0]?.nonceHighWater, '1024');
  });

  test('migrates legacy key records to a nonzero nonce range', () => {
    const dataDir = tempDir();
    const safeStorage = fakeSafeStorage(0x5a);
    KeyStore.open({ safeStorage, dataDir });
    const keysPath = join(dataDir, 'keys.json');
    const file = JSON.parse(readFileSync(keysPath, 'utf8')) as {
      keys: { nonceHighWater?: string }[];
    };
    if (file.keys[0] !== undefined) delete file.keys[0].nonceHighWater;
    writeFileSync(keysPath, JSON.stringify(file));

    const migrated = KeyStore.open({ safeStorage, dataDir });
    const reserve = migrated.currentKey().reserveNoncePrefix;
    assert.ok(reserve !== undefined);
    assert.ok(reserve().readBigUInt64BE() >= 1n << 63n);
    const persisted = JSON.parse(readFileSync(keysPath, 'utf8')) as {
      keys: { nonceHighWater?: string }[];
    };
    assert.ok(persisted.keys[0]?.nonceHighWater !== undefined);
  });

  test('master key on disk is never plaintext', () => {
    const dataDir = tempDir();
    const store = KeyStore.open({ safeStorage: fakeSafeStorage(0x5a), dataDir });
    const onDisk = readFileSync(join(dataDir, 'master.key'));
    assert.ok(!onDisk.includes(store.currentKey().key.toString('base64').slice(0, 8)));
  });

  test('rotation produces KEY #2 as the write key; old-key decrypts still pass', async () => {
    const dataDir = tempDir();
    const store = KeyStore.open({ safeStorage: fakeSafeStorage(0x5a), dataDir });
    const plaintext = randomBytes(4096);
    const context = { photoId: 'photo-1' };
    const envelope = await buffer(Readable.from([plaintext]).pipe(createEncryptStream(store.currentKey(), context, { chunkSize: 1024 })));

    const rotated = store.rotate();
    assert.equal(rotated.id, 2);
    assert.equal(store.currentKey().id, 2);
    assert.deepEqual(
      store.listKeys().map((key) => ({ id: key.id, status: key.status })),
      [
        { id: 1, status: 'retired' },
        { id: 2, status: 'active' },
      ],
    );

    // KEY #1 envelope still decrypts through the resolver.
    const roundTripped = await buffer(Readable.from([envelope]).pipe(createDecryptStream(store.resolver(), context)));
    assert.deepEqual(roundTripped, plaintext);
  });

  test('rotation survives restart', () => {
    const dataDir = tempDir();
    const safeStorage = fakeSafeStorage(0x11);
    const store = KeyStore.open({ safeStorage, dataDir });
    store.rotate();
    store.rotate();
    const reopened = KeyStore.open({ safeStorage, dataDir });
    assert.equal(reopened.currentKey().id, 3);
    assert.equal(reopened.listKeys().length, 3);
    assert.ok(reopened.resolver()(1) !== undefined, 'retired key 1 still resolvable');
  });

  test('createdAt uses the injected clock', () => {
    const dataDir = tempDir();
    const store = KeyStore.open({
      safeStorage: fakeSafeStorage(0x5a),
      dataDir,
      now: () => new Date('2026-07-12T00:00:00.000Z'),
    });
    assert.equal(store.listKeys()[0]?.createdAt, '2026-07-12T00:00:00.000Z');
  });

  test('authorized master opens configured custody and close revokes every resolver', () => {
    const dataDir = tempDir();
    const safeStorage = fakeSafeStorage(0x5a);
    const legacy = KeyStore.open({ safeStorage, dataDir });
    const master = legacy.masterKeyBytes();
    const key = Buffer.from(legacy.currentKey().key);
    legacy.close();

    const authorized = KeyStore.openWithMaster({ safeStorage, dataDir }, master);
    assert.deepEqual(authorized.currentKey().key, key);
    authorized.close();
    assert.equal(authorized.resolver()(1), undefined);
    assert.throws(() => authorized.currentKey(), /not unwrapped/);
    master.fill(0);
  });
});

describe('KeyStore failure paths', () => {
  test('keychain unavailable throws a custody error — no plaintext fallback', () => {
    assert.throws(
      () => KeyStore.open({ safeStorage: fakeSafeStorage(0x5a, false), dataDir: tempDir() }),
      (error: unknown) => {
        assert.ok(error instanceof KeyCustodyError);
        assert.match(error.message, /no plaintext fallback/);
        return true;
      },
    );
  });

  test('a different OS keychain identity cannot unwrap the master key', () => {
    const dataDir = tempDir();
    KeyStore.open({ safeStorage: fakeSafeStorage(0x5a), dataDir });
    // The XOR fake decrypts to garbage instead of throwing, so this is the
    // malformed branch. A keychain that throws is covered below.
    assert.equal(probeMasterUnwrap(fakeSafeStorage(0x77), dataDir), 'malformed');
    assert.throws(() => KeyStore.open({ safeStorage: fakeSafeStorage(0x77), dataDir }), /master key (could not be unwrapped|is malformed)/);
  });

  test('probe reports first-run, a damaged master, a missing keychain, and an app-lock record', () => {
    const empty = tempDir();
    assert.equal(probeMasterUnwrap(fakeSafeStorage(0x5a), empty), 'ok');
    assert.equal(probeMasterUnwrap(fakeSafeStorage(0x5a, false), empty), 'keychain-unavailable');

    const damaged = tempDir();
    writeFileSync(join(damaged, 'master.key'), fakeSafeStorage(0x5a).encryptString('short'));
    assert.equal(probeMasterUnwrap(fakeSafeStorage(0x5a), damaged), 'malformed');

    const locked = tempDir();
    writeFileSync(join(locked, 'master.key'), Buffer.from('OVLK-not-a-legacy-master'));
    assert.equal(probeMasterUnwrap(fakeSafeStorage(0x5a), locked), 'ok');
    assert.equal(probeMasterUnwrap(fakeSafeStorage(0x5a, false), locked), 'ok');

    const unreadable = tempDir();
    mkdirSync(join(unreadable, 'master.key'));
    assert.equal(probeMasterUnwrap(fakeSafeStorage(0x5a), unreadable), 'malformed');

    const sealed = tempDir();
    writeFileSync(join(sealed, 'master.key'), Buffer.from('sealed'));
    const throwing: SafeStorageLike = {
      ...fakeSafeStorage(0x5a),
      decryptString: () => {
        throw new Error('keychain');
      },
    };
    assert.equal(probeMasterUnwrap(throwing, sealed), 'unwrap-failed');
  });

  test('a tampered keys.json fails key authentication loudly', () => {
    const dataDir = tempDir();
    const safeStorage = fakeSafeStorage(0x5a);
    KeyStore.open({ safeStorage, dataDir });
    const keysPath = join(dataDir, 'keys.json');
    const file = JSON.parse(readFileSync(keysPath, 'utf8')) as {
      keys: { wrappedKey: string }[];
    };
    const wrapped = Buffer.from(file.keys[0]?.wrappedKey ?? '', 'base64');
    wrapped[wrapped.length - 1] = (wrapped[wrapped.length - 1] ?? 0) ^ 0xff;
    file.keys[0] = { ...file.keys[0], wrappedKey: wrapped.toString('base64') };
    writeFileSync(keysPath, JSON.stringify(file));
    assert.throws(() => KeyStore.open({ safeStorage, dataDir }), /failed authentication/);
  });

  test('an existing master key with missing keys.json refuses to mint a new KEY #1', () => {
    const dataDir = tempDir();
    const safeStorage = fakeSafeStorage(0x5a);
    KeyStore.open({ safeStorage, dataDir });
    rmSync(join(dataDir, 'keys.json'));
    assert.throws(() => KeyStore.open({ safeStorage, dataDir }), /refusing to regenerate KEY #1/);
  });

  test('an existing master key with an emptied keys list refuses likewise', () => {
    const dataDir = tempDir();
    const safeStorage = fakeSafeStorage(0x5a);
    KeyStore.open({ safeStorage, dataDir });
    writeFileSync(join(dataDir, 'keys.json'), JSON.stringify({ version: 1, keys: [] }));
    assert.throws(() => KeyStore.open({ safeStorage, dataDir }), /refusing to regenerate KEY #1/);
  });

  test('a truncated wrapped key is reported as malformed', () => {
    const dataDir = tempDir();
    const safeStorage = fakeSafeStorage(0x5a);
    KeyStore.open({ safeStorage, dataDir });
    const keysPath = join(dataDir, 'keys.json');
    const file = JSON.parse(readFileSync(keysPath, 'utf8')) as { keys: { wrappedKey: string }[] };
    file.keys[0] = { ...file.keys[0], wrappedKey: Buffer.alloc(8).toString('base64') };
    writeFileSync(keysPath, JSON.stringify(file));
    assert.throws(() => KeyStore.open({ safeStorage, dataDir }), /is malformed/);
  });

  test('an exhausted nonce prefix space fails closed and requires rotation', () => {
    const dataDir = tempDir();
    const safeStorage = fakeSafeStorage(0x5a);
    KeyStore.open({ safeStorage, dataDir });
    const keysPath = join(dataDir, 'keys.json');
    const file = JSON.parse(readFileSync(keysPath, 'utf8')) as {
      keys: { nonceHighWater: string }[];
    };
    if (file.keys[0] !== undefined) file.keys[0].nonceHighWater = (1n << 64n).toString();
    writeFileSync(keysPath, JSON.stringify(file));

    const exhausted = KeyStore.open({ safeStorage, dataDir });
    const reserve = exhausted.currentKey().reserveNoncePrefix;
    assert.ok(reserve !== undefined);
    assert.throws(() => reserve(), /exhausted its 64-bit nonce prefix space; rotate the library key/u);
  });
});
