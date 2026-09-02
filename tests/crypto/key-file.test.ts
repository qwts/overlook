import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';

import {
  KEY_FILE_LENGTH,
  KeyFileError,
  keyFingerprintOf,
  openKeyFile,
  readKeyFileFacts,
  sealKeyFile,
} from '../../src/main/crypto/key-file.js';
import { keyFileName } from '../../src/shared/keyring/types.js';

// #517 / ADR-0032 §2: an exported key travels as a fixed-length,
// password-sealed file whose registry facts (kind, reference, version) are
// readable without the password — so import can name the row it would
// unlock before any key derivation — while the material itself is
// authenticated together with those facts.

const PASSWORD = 'Correct Horse Battery 9!';
const FACTS = { kind: 'library' as const, keyRef: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', version: 1 };

function reasonOf(error: unknown): string | null {
  return error instanceof KeyFileError ? error.reason : null;
}

describe('key file (#517)', () => {
  test('seals to a fixed-length file whose facts read without the password and whose key never appears in clear', () => {
    const key = randomBytes(32);
    const data = sealKeyFile(key, FACTS, PASSWORD);
    assert.equal(data.length, KEY_FILE_LENGTH);
    assert.deepEqual(readKeyFileFacts(data), FACTS);
    assert.equal(data.includes(key), false);
    const opened = openKeyFile(data, PASSWORD);
    assert.deepEqual(opened.key, key);
    assert.deepEqual({ kind: opened.kind, keyRef: opened.keyRef, version: opened.version }, FACTS);
  });

  test('the wrong password, a flipped byte anywhere, and a foreign file all fail closed', () => {
    const data = sealKeyFile(randomBytes(32), FACTS, PASSWORD);
    assert.equal(reasonOf(catchOf(() => openKeyFile(data, 'not the password'))), 'wrong-password');
    const tamperedBody = Buffer.from(data);
    tamperedBody.writeUInt8(tamperedBody.readUInt8(KEY_FILE_LENGTH - 1) ^ 0x01, KEY_FILE_LENGTH - 1);
    assert.equal(reasonOf(catchOf(() => openKeyFile(tamperedBody, PASSWORD))), 'wrong-password');
    const tamperedFacts = Buffer.from(data);
    tamperedFacts.writeUInt8(tamperedFacts.readUInt8(6) ^ 0x01, 6); // inside the key reference
    assert.notEqual(reasonOf(catchOf(() => openKeyFile(tamperedFacts, PASSWORD))), null, 'the facts are authenticated with the key');
    assert.equal(reasonOf(catchOf(() => readKeyFileFacts(data.subarray(0, KEY_FILE_LENGTH - 1)))), 'invalid');
    assert.equal(reasonOf(catchOf(() => readKeyFileFacts(randomBytes(KEY_FILE_LENGTH)))), 'invalid');
  });

  test('fingerprints are deterministic, display-formatted, and the file name carries the reference and version', () => {
    const key = randomBytes(32);
    assert.match(keyFingerprintOf(key), /^[0-9A-F]{4}·[0-9A-F]{4}·[0-9A-F]{4}·[0-9A-F]{4}$/u);
    assert.equal(keyFingerprintOf(key), keyFingerprintOf(Buffer.from(key)));
    assert.notEqual(keyFingerprintOf(key), keyFingerprintOf(randomBytes(32)));
    assert.equal(keyFileName(FACTS.keyRef, 2), 'overlook-key-a1b2c3d4-v2.key');
  });
});

function catchOf(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}
