import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { KeyCustodyError, type SafeStorageLike } from '../../src/main/crypto/keystore.js';
import { clearLibraryCustodyBlock, readLibraryCustody, takeLibraryKeyStore } from '../../src/main/library/library-custody.js';

afterEach(() => {
  clearLibraryCustodyBlock();
});

test('a cached unwrap failure does not apply to another library', () => {
  assert.equal(
    readLibraryCustody(false, '/library-a', () => 'unwrap-failed'),
    'unwrap-failed',
  );
  assert.equal(
    readLibraryCustody(false, '/library-a', () => 'ok'),
    'unwrap-failed',
  );
  assert.equal(
    readLibraryCustody(false, '/library-b', () => 'ok'),
    'ok',
  );
  assert.equal(
    readLibraryCustody(true, '/library-a', () => 'unwrap-failed'),
    'ok',
  );
});

test('a failed unwrap is remembered and does not take the library lock', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-custody-'));
  const safeStorage: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(plain),
    decryptString: () => {
      throw new Error('keychain');
    },
  };
  writeFileSync(join(dataDir, 'master.key'), Buffer.from('sealed'));
  let acquired = false;
  try {
    assert.throws(
      () =>
        takeLibraryKeyStore(dataDir, 'instance', safeStorage, undefined, undefined, () => {
          acquired = true;
          return () => undefined;
        }),
      (error: unknown) => error instanceof KeyCustodyError && /could not be unwrapped/u.test(error.message),
    );
    assert.equal(acquired, false);
    assert.equal(
      readLibraryCustody(false, dataDir, () => 'ok'),
      'unwrap-failed',
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
