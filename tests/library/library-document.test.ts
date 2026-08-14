import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { describe, test } from 'node:test';

import { LibraryRegistry } from '../../src/main/library/library-registry.js';
import { LibraryDocumentRouter } from '../../src/main/library/library-document-router.js';
import { updateLibraryDocumentSummaryName, writeLibraryDocumentSummary } from '../../src/main/library/library-document-summary.js';
import type { SwitchOutcome } from '../../src/main/library/switch-runtime.js';
import {
  ensureLibraryDocumentPath,
  isLibraryDocumentPath,
  LIBRARY_SUMMARY_FILE,
  libraryDocumentSummarySchema,
} from '../../src/shared/library/library-document.js';

const ID_A = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const ID_B = '01K00000000000000000000000';

function library(root: string, name: string, id: string): string {
  const directory = path.join(root, `${name}.overlooklibrary`);
  mkdirSync(directory);
  writeFileSync(path.join(directory, 'library-id'), id);
  writeFileSync(path.join(directory, 'library.db'), 'encrypted');
  return directory;
}

describe('Finder library document identity (#799)', () => {
  test('recognizes the package suffix and writes only the bounded public summary', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'overlook-library-document-'));
    const directory = library(root, 'Family', ID_A);
    assert.equal(isLibraryDocumentPath(directory.toUpperCase()), true);
    assert.equal(ensureLibraryDocumentPath(directory), directory);
    assert.equal(ensureLibraryDocumentPath(path.join(root, 'Archive')), path.join(root, 'Archive.overlooklibrary'));
    writeLibraryDocumentSummary(directory, {
      version: 1,
      name: 'Family',
      itemCount: 42,
      updatedAt: '2026-08-14T12:00:00.000Z',
    });
    const raw = readFileSync(path.join(directory, LIBRARY_SUMMARY_FILE), 'utf8');
    assert.deepEqual(libraryDocumentSummarySchema.parse(JSON.parse(raw)), {
      version: 1,
      name: 'Family',
      itemCount: 42,
      updatedAt: '2026-08-14T12:00:00.000Z',
    });
    for (const forbidden of ['photo', 'album', 'key', 'database', 'blob']) assert.doesNotMatch(raw, new RegExp(forbidden, 'iu'));
    updateLibraryDocumentSummaryName(directory, 'Archive');
    const renamed = libraryDocumentSummarySchema.parse(
      JSON.parse(readFileSync(path.join(directory, LIBRARY_SUMMARY_FILE), 'utf8')) as unknown,
    );
    assert.equal(renamed.name, 'Archive');

    writeFileSync(path.join(directory, LIBRARY_SUMMARY_FILE), '{broken');
    updateLibraryDocumentSummaryName(directory, 'Ignored');
    assert.equal(readFileSync(path.join(directory, LIBRARY_SUMMARY_FILE), 'utf8'), '{broken');
  });
});

describe('Finder library document routing (#799)', () => {
  test('registers valid packages and repairs only a missing registered location', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'overlook-library-router-'));
    const registry = new LibraryRegistry({ filePath: path.join(root, 'libraries.json') });
    const first = library(root, 'First', ID_A);
    writeLibraryDocumentSummary(first, { version: 1, name: 'Summary Name', itemCount: 0, updatedAt: '2026-08-14T12:00:00.000Z' });
    const opened: string[] = [];
    const failures: string[] = [];
    const router = new LibraryDocumentRouter({
      registry,
      open: (id) => {
        opened.push(id);
        return Promise.resolve({
          ok: true,
          library: { ...registry.get(id)!, missing: false, open: true, lockedBy: null },
          requiresRestart: false,
        });
      },
      failure: (message) => failures.push(message),
    });
    await router.open(first);
    assert.equal(registry.get(ID_A)?.path, first);
    assert.equal(registry.get(ID_A)?.name, 'Summary Name');
    assert.deepEqual(opened, [ID_A]);

    const missing = path.join(root, 'Missing.overlooklibrary');
    registry.register({ id: ID_B, name: 'Missing', path: missing, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: null });
    const moved = library(root, 'Moved', ID_B);
    await router.open(moved);
    assert.equal(registry.get(ID_B)?.path, moved);
    assert.deepEqual(failures, []);
  });

  test('refuses invalid packages and duplicate live identities', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'overlook-library-router-refuse-'));
    const registry = new LibraryRegistry({ filePath: path.join(root, 'libraries.json') });
    const original = library(root, 'Original', ID_A);
    registry.register({ id: ID_A, name: 'Original', path: original, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: null });
    const duplicate = library(root, 'Duplicate', ID_A);
    const invalid = path.join(root, 'Invalid.overlooklibrary');
    mkdirSync(invalid);
    const failures: string[] = [];
    const router = new LibraryDocumentRouter({
      registry,
      open: () => Promise.reject(new Error('must not open')),
      failure: (message) => failures.push(message),
    });
    await router.open(duplicate);
    await router.open(invalid);
    await router.open(path.join(root, 'plain-library'));
    assert.equal(existsSync(original), true);
    assert.deepEqual(failures, [
      'This library identity is already registered at another location.',
      'This item is not a valid Overlook library.',
      'This item is not a valid Overlook library.',
    ]);
  });

  test('surfaces switch refusal without changing document identity', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'overlook-library-router-locked-'));
    const registry = new LibraryRegistry({ filePath: path.join(root, 'libraries.json') });
    const directory = library(root, 'Locked', ID_A);
    const failures: string[] = [];
    const router = new LibraryDocumentRouter({
      registry,
      open: () => Promise.resolve({ ok: false, reason: 'locked-elsewhere', host: 'Studio Mac' }),
      failure: (message) => failures.push(message),
    });
    await router.open(directory);
    assert.equal(registry.get(ID_A)?.path, directory);
    assert.deepEqual(failures, ['The library is open on Studio Mac.']);
  });
});

describe('Finder library document failures (#799)', () => {
  test('surfaces every switch refusal and unexpected registry or open failure', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'overlook-library-router-errors-'));
    const cases: readonly [Extract<SwitchOutcome, { readonly ok: false }>, string][] = [
      [{ ok: false, reason: 'missing', host: null }, 'The registered library is missing.'],
      [{ ok: false, reason: 'locked-elsewhere', host: null }, 'The library is open on another Mac.'],
      [{ ok: false, reason: 'provider-busy', host: null }, 'Wait for current storage work to finish before opening another library.'],
      [{ ok: false, reason: 'switch-in-progress', host: null }, 'Another library is already opening.'],
      [{ ok: false, reason: 'locked', host: null }, 'Unlock Overlook before opening another library.'],
    ];
    for (const [index, [outcome, message]] of cases.entries()) {
      const registry = new LibraryRegistry({ filePath: path.join(root, `${outcome.reason}.json`) });
      const directory = library(root, outcome.reason, `${ID_A.slice(0, -1)}${String(index)}`);
      const failures: string[] = [];
      const router = new LibraryDocumentRouter({
        registry,
        open: () => Promise.resolve(outcome),
        failure: (value) => failures.push(value),
      });
      await router.open(directory);
      assert.deepEqual(failures, [message]);
    }

    const openFailure = library(root, 'OpenFailure', ID_B);
    const failures: string[] = [];
    const registry = new LibraryRegistry({ filePath: path.join(root, 'open-failure.json') });
    const router = new LibraryDocumentRouter({
      registry,
      open: () => Promise.reject(new Error('unexpected')),
      failure: (value) => failures.push(value),
    });
    await router.open(openFailure);
    assert.deepEqual(failures, ['The library could not be opened.']);

    const registryFailure = library(root, 'RegistryFailure', ID_A);
    const conflictingRegistry = new LibraryRegistry({ filePath: path.join(root, 'registry-failure.json') });
    conflictingRegistry.register({
      id: ID_B,
      name: 'Conflict',
      path: registryFailure,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastOpenedAt: null,
    });
    const registryFailures: string[] = [];
    const conflictingRouter = new LibraryDocumentRouter({
      registry: conflictingRegistry,
      open: () => Promise.reject(new Error('must not open')),
      failure: (value) => registryFailures.push(value),
    });
    await conflictingRouter.open(registryFailure);
    assert.equal(registryFailures.length, 1);
    assert.match(registryFailures[0] ?? '', /path is already registered/u);
  });
});
