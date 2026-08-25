import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import {
  RecoveryBootstrapError,
  openRecoveryBootstrap,
  recoveryBootstrapResolver,
  sealKeyStoreRecoveryBootstrap,
  sealRecoveryBootstrap,
  type RecoveryBootstrap,
} from '../../src/main/backup/recovery-bootstrap.js';
import { createDecryptStream, createEncryptStream } from '../../src/main/crypto/envelope.js';
import { KeyStore, type SafeStorageLike } from '../../src/main/crypto/keystore.js';

function safeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(plainText, 'utf8'),
    decryptString: (encrypted) => encrypted.toString('utf8'),
  };
}

function world(): { bootstrap: RecoveryBootstrap; masterKey: Buffer; keyStore: KeyStore } {
  const keyStore = KeyStore.open({
    safeStorage: safeStorage(),
    dataDir: mkdtempSync(join(tmpdir(), 'overlook-bootstrap-')),
    now: () => new Date('2026-07-14T23:00:00.000Z'),
  });
  keyStore.rotate();
  return {
    keyStore,
    masterKey: keyStore.masterKeyBytes(),
    bootstrap: {
      schema: 1,
      libraryId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      generatedAt: '2026-07-14T23:05:00.000Z',
      keys: keyStore.exportWrappedKeys(),
    },
  };
}

describe('cloud recovery bootstrap (#289)', () => {
  test('a fresh process resolves every envelope key from remote bytes plus the recovered master', async () => {
    const { bootstrap, masterKey, keyStore } = world();
    const oldKey = keyStore.resolver()(1);
    assert.ok(oldKey !== undefined);
    const context = { photoId: 'P1' };
    const plaintext = Buffer.from('recoverable original');
    const encrypted = await buffer(Readable.from([plaintext]).pipe(createEncryptStream({ id: 1, key: oldKey }, context)));

    const remoteBytes = sealRecoveryBootstrap(bootstrap, masterKey);
    const reopened = openRecoveryBootstrap(remoteBytes, masterKey);
    const restored = await buffer(
      Readable.from([encrypted]).pipe(createDecryptStream(recoveryBootstrapResolver(reopened, masterKey), context)),
    );

    assert.deepEqual(restored, plaintext);
    assert.deepEqual(
      reopened.keys.map(({ id, status }) => ({ id, status })),
      [
        { id: 1, status: 'retired' },
        { id: 2, status: 'active' },
      ],
    );
  });

  test('wrong master keys and tampering fail authentication', () => {
    const { bootstrap, masterKey } = world();
    const sealed = sealRecoveryBootstrap(bootstrap, masterKey);
    assert.throws(() => openRecoveryBootstrap(sealed, randomBytes(32)), /failed authentication/u);
    sealed[sealed.length - 17] = (sealed[sealed.length - 17] ?? 0) ^ 0xff;
    assert.throws(() => openRecoveryBootstrap(sealed, masterKey), /failed authentication/u);
  });

  test('the composition helper wipes its temporary master-key copy', () => {
    const { bootstrap, masterKey, keyStore } = world();
    const temporary = Buffer.from(masterKey);
    const sealed = sealKeyStoreRecoveryBootstrap({
      keyStore: {
        masterKeyBytes: () => temporary,
        exportWrappedKeys: () => keyStore.exportWrappedKeys(),
      },
      libraryId: bootstrap.libraryId,
      generatedAt: bootstrap.generatedAt,
      manifestGeneration: 7,
    });
    assert.ok(temporary.every((byte) => byte === 0));
    assert.deepEqual(openRecoveryBootstrap(sealed, masterKey), {
      schema: 2,
      libraryId: bootstrap.libraryId,
      generatedAt: bootstrap.generatedAt,
      manifestGeneration: 7,
      keys: keyStore.exportWrappedKeys(),
    });
  });

  test('OVRB v1 stays readable while new schema 2 authenticates the manifest generation', () => {
    const { bootstrap, masterKey } = world();
    const legacy = sealRecoveryBootstrap(bootstrap, masterKey);
    const current = sealRecoveryBootstrap({ ...bootstrap, schema: 2, manifestGeneration: 42 }, masterKey);

    assert.equal(legacy.readUInt8(4), 1);
    assert.equal(current.readUInt8(4), 2);
    assert.equal(openRecoveryBootstrap(legacy, masterKey).schema, 1);
    assert.deepEqual(openRecoveryBootstrap(current, masterKey), { ...bootstrap, schema: 2, manifestGeneration: 42 });
  });

  test('invalid key sets fail before upload', () => {
    const { bootstrap, masterKey } = world();
    const first = bootstrap.keys[0];
    const second = bootstrap.keys[1];
    assert.ok(first !== undefined);
    assert.ok(second !== undefined);
    const duplicate = { ...bootstrap, keys: [first, first] };
    assert.throws(() => sealRecoveryBootstrap(duplicate, masterKey), /key IDs must be unique/u);

    const noActive = { ...bootstrap, keys: bootstrap.keys.map((key) => ({ ...key, status: 'retired' as const })) };
    assert.throws(() => sealRecoveryBootstrap(noActive, masterKey), /exactly one key must be active/u);

    const malformed = { ...bootstrap, keys: [{ ...first, wrappedKey: `${first.wrappedKey}!!` }, second] };
    assert.throws(() => sealRecoveryBootstrap(malformed, masterKey), /invalid wrapped-key encoding/u);

    const exhausted = { ...bootstrap, keys: [{ ...first, nonceHighWater: ((1n << 64n) + 1n).toString() }, second] };
    assert.throws(() => sealRecoveryBootstrap(exhausted, masterKey), /nonce high-water mark exceeds/u);

    const unsafeGeneration = { ...bootstrap, schema: 2 as const, manifestGeneration: Number.MAX_SAFE_INTEGER + 1 };
    assert.throws(() => sealRecoveryBootstrap(unsafeGeneration, masterKey));
  });

  test('invalid outer framing and master-key lengths fail closed', () => {
    const { bootstrap, masterKey } = world();
    assert.throws(() => sealRecoveryBootstrap(bootstrap, Buffer.alloc(31)), RecoveryBootstrapError);
    assert.throws(() => openRecoveryBootstrap(Buffer.from('not-a-bootstrap'), masterKey), /invalid recovery-bootstrap length/u);
  });
});
