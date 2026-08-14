import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibraryRegistryRuntime } from '../../src/main/library/library-registry-runtime.js';
import { KeyStore, type SafeStorageLike } from '../../src/main/crypto/keystore.js';
import { LibraryDatabaseError, openLibraryDatabase } from '../../src/main/db/database.js';
import { LIBRARY_SUMMARY_FILE, libraryDocumentSummarySchema } from '../../src/shared/library/library-document.js';

// #384 acceptance 2 (ADR-0017 §2/§3): two provisioned libraries open with
// distinct keys, and a cross-library key fails closed at the SQLCipher
// boundary — key isolation is structural, not a UI rule.

function fakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(`sealed:${plainText}`, 'utf8'),
    decryptString: (encrypted) => encrypted.toString('utf8').replace(/^sealed:/, ''),
  };
}

function runtimeIn(userData: string): LibraryRegistryRuntime {
  return new LibraryRegistryRuntime({ userDataDir: () => userData });
}

describe('multi-library keying (#384)', () => {
  test('ACCEPTANCE: create provisions per-directory custody at the default location', () => {
    const userData = mkdtempSync(join(tmpdir(), 'overlook-multi-'));
    const runtime = runtimeIn(userData);
    const entry = runtime.create({ name: 'Second', path: null, safeStorage: fakeSafeStorage() });

    assert.equal(entry.path, join(userData, 'libraries', entry.id), 'default home is userData/libraries/<ulid>');
    assert.equal(readFileSync(join(entry.path, 'library-id'), 'utf8'), entry.id, 'directory identity pinned to the registry id');
    assert.ok(existsSync(join(entry.path, 'master.key')), 'master key provisioned');
    assert.ok(existsSync(join(entry.path, 'keys.json')), 'KEY #1 provisioned');
    assert.ok(existsSync(join(entry.path, 'library.db')), 'create provisions the empty database too (#385: restore gate keys off it)');
  });

  test('ACCEPTANCE: two libraries open with distinct keys; the wrong key fails closed', () => {
    const userData = mkdtempSync(join(tmpdir(), 'overlook-multi-'));
    const runtime = runtimeIn(userData);
    const safeStorage = fakeSafeStorage();
    const a = runtime.create({ name: 'A', path: null, safeStorage });
    const b = runtime.create({ name: 'B', path: join(userData, 'custom-spot'), safeStorage });

    assert.equal(b.path, join(userData, 'custom-spot.overlooklibrary'), 'explicit custom homes use the Finder package suffix');

    const keyA = KeyStore.open({ safeStorage, dataDir: a.path }).resolver()(1);
    const keyB = KeyStore.open({ safeStorage, dataDir: b.path }).resolver()(1);
    assert.ok(keyA !== undefined && keyB !== undefined);
    assert.notDeepEqual(keyA, keyB, 'each library minted its own KEY #1');

    const dbA = openLibraryDatabase({ path: join(a.path, 'library.db'), dbKey: keyA });
    dbA.close();
    const dbB = openLibraryDatabase({ path: join(b.path, 'library.db'), dbKey: keyB });
    dbB.close();

    assert.throws(
      () => openLibraryDatabase({ path: join(a.path, 'library.db'), dbKey: keyB }),
      (error: unknown) => error instanceof LibraryDatabaseError,
      "library B's key cannot open library A",
    );
  });

  test('a failed create cleans up a directory it created and registers nothing', () => {
    const userData = mkdtempSync(join(tmpdir(), 'overlook-multi-'));
    const runtime = runtimeIn(userData);
    const unavailable: SafeStorageLike = { ...fakeSafeStorage(), isEncryptionAvailable: () => false };

    assert.throws(() => runtime.create({ name: 'Broken', path: null, safeStorage: unavailable }));
    assert.deepEqual(runtime.getRegistry().list(), [], 'nothing registered');
    assert.ok(
      !existsSync(join(userData, 'libraries')) || readdirSync(join(userData, 'libraries')).length === 0,
      'no orphan directory left behind',
    );
  });
});

describe('Finder library document runtime (#799)', () => {
  test('refreshes and closes the bounded Finder summary subscription', () => {
    const userData = mkdtempSync(join(tmpdir(), 'overlook-multi-summary-'));
    const created = runtimeIn(userData).create({ name: 'Family', path: join(userData, 'Family'), safeStorage: fakeSafeStorage() });
    const runtime = runtimeIn(userData);
    let itemCount = 2;
    let refresh = (): void => undefined;
    let closed = 0;
    runtime.followDocumentSummary(
      () => itemCount,
      (listener) => {
        refresh = listener;
        return () => {
          closed += 1;
        };
      },
    );
    const summaryPath = join(created.path, LIBRARY_SUMMARY_FILE);
    assert.equal(libraryDocumentSummarySchema.parse(JSON.parse(readFileSync(summaryPath, 'utf8')) as unknown).itemCount, 2);
    itemCount = 3;
    refresh();
    assert.equal(libraryDocumentSummarySchema.parse(JSON.parse(readFileSync(summaryPath, 'utf8')) as unknown).itemCount, 3);

    runtime.followDocumentSummary(
      () => itemCount,
      () => () => (closed += 1),
    );
    assert.equal(closed, 1, 'replacing a subscription closes the prior listener');
    runtime.closeDocumentSummary();
    assert.equal(closed, 2);
  });

  test('keeps relocation and create-location pickers distinct', async () => {
    const runtime = runtimeIn(mkdtempSync(join(tmpdir(), 'overlook-multi-pickers-')));
    const facade = runtime.facade({
      openLibraryId: () => null,
      safeStorage: fakeSafeStorage,
      pickDirectory: () => Promise.resolve('/move-root'),
      pickCreateLocation: () => Promise.resolve('/Family.overlooklibrary'),
    });
    assert.deepEqual(await facade.pickLocation(), { path: '/move-root' });
    assert.deepEqual(await facade.pickCreateLocation(), { path: '/Family.overlooklibrary' });
  });
});
