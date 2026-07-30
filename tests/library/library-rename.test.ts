import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibraryRegistry } from '../../src/main/library/library-registry.js';
import { recoverRelocations, relocateLibrary, type RelocationDeps } from '../../src/main/library/relocation-engine.js';
import { RelocationJournalStore } from '../../src/main/library/relocation-journal.js';
import { RelocationRuntime } from '../../src/main/library/relocation-runtime.js';
import { RELOCATION_MARKER_FILENAME } from '../../src/shared/library/relocation.js';

// Rename a library folder in place (#686): the final path component changes
// through the journaled ADR-0022 engine — same parent, same identity, no
// direct-rename bypass. Case-only renames alias source and destination on
// case-insensitive filesystems and get their own preflight/recovery shape.

const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const ULID_B = '01BRZ3NDEKTSV4RRFFQ69G5FAB';
const NOW = () => new Date('2026-07-19T12:00:00.000Z');

const LIB_FILES: Record<string, string> = {
  'library-id': `${ULID_A}\n`,
  'library.db': 'db-bytes',
  'blobs/aa/aabbcc': 'encrypted-bytes',
};

function makeLibrary(dir: string): void {
  for (const [rel, content] of Object.entries(LIB_FILES)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content, 'utf8');
  }
}

interface Harness {
  readonly root: string;
  readonly sourceDir: string;
  readonly registry: LibraryRegistry;
  readonly journals: RelocationJournalStore;
  readonly deps: RelocationDeps;
}

function harness(folderName = 'My Library'): Harness {
  const root = mkdtempSync(join(tmpdir(), 'overlook-rename-'));
  const sourceDir = join(root, 'disk', folderName);
  makeLibrary(sourceDir);
  const registry = new LibraryRegistry({ filePath: join(root, 'libraries.json'), now: NOW });
  registry.register({ id: ULID_A, name: 'My Library', path: sourceDir, createdAt: NOW().toISOString(), lastOpenedAt: null });
  const journals = new RelocationJournalStore(join(root, 'relocations'));
  const deps: RelocationDeps = {
    journals,
    registry,
    instanceId: 'test-instance',
    now: NOW,
    nonce: () => 'rename-nonce',
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    lockOptions: { host: 'testhost', pid: 1234, isPidAlive: () => false, now: NOW },
  };
  return { root, sourceDir, registry, journals, deps };
}

/** The tmpdir's real case behavior — macOS is usually insensitive, CI Linux
 * is sensitive; case-only assertions branch on the actual filesystem. */
function caseInsensitiveTmp(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'overlook-case-'));
  mkdirSync(join(probe, 'Case-Probe'));
  return existsSync(join(probe, 'case-probe'));
}

describe('rename a library folder safely (#686)', () => {
  test('ACCEPTANCE: rename in place — new folder name on disk, same id and content, registry committed, no leftovers', async () => {
    const h = harness();
    const destDir = join(h.root, 'disk', 'Family Photos');

    const result = await relocateLibrary(h.deps, { libraryId: ULID_A, destDir });

    assert.equal(result.outcome, 'moved');
    assert.equal(result.mode, 'rename');
    assert.deepEqual(readdirSync(join(h.root, 'disk')), ['Family Photos'], 'exactly one directory holds the library');
    for (const [rel, content] of Object.entries(LIB_FILES)) {
      assert.equal(readFileSync(join(destDir, rel), 'utf8'), content, `${rel} intact`);
    }
    assert.equal(h.registry.get(ULID_A)?.path, destDir, 'registry points at the renamed folder');
    assert.equal(h.journals.load(ULID_A), null, 'journal cleared');
    assert.ok(!existsSync(join(destDir, RELOCATION_MARKER_FILENAME)), 'no marker debris');
  });

  test('a case-only rename succeeds on this filesystem, whatever its case sensitivity', async () => {
    const h = harness('photos');
    const destDir = join(h.root, 'disk', 'PHOTOS');

    const result = await relocateLibrary(h.deps, { libraryId: ULID_A, destDir });

    assert.equal(result.outcome, 'moved');
    assert.equal(result.mode, 'rename');
    assert.deepEqual(readdirSync(join(h.root, 'disk')), ['PHOTOS'], 'the directory entry carries the new case');
    assert.equal(h.registry.get(ULID_A)?.path, destDir);
    assert.equal(readFileSync(join(destDir, 'library-id'), 'utf8'), LIB_FILES['library-id']);
    assert.equal(h.journals.load(ULID_A), null);
  });

  test('renaming onto an occupied sibling refuses and leaves everything untouched', async () => {
    const h = harness();
    const destDir = join(h.root, 'disk', 'Occupied');
    mkdirSync(destDir);
    writeFileSync(join(destDir, 'somebody-elses-file'), 'x', 'utf8');

    await assert.rejects(relocateLibrary(h.deps, { libraryId: ULID_A, destDir }), /not empty/);
    assert.equal(h.registry.get(ULID_A)?.path, h.sourceDir, 'registry untouched');
    assert.ok(existsSync(join(h.sourceDir, 'library.db')), 'source untouched');
    assert.ok(existsSync(join(destDir, 'somebody-elses-file')), 'occupant untouched');
  });

  describe('case-only crash recovery disambiguates by the actual directory entry', { skip: !caseInsensitiveTmp() }, () => {
    test('rename happened before the crash → the journal rolls the commit forward', async () => {
      const h = harness('photos');
      const destDir = join(h.root, 'disk', 'PHOTOS');
      writeFileSync(
        join(h.sourceDir, RELOCATION_MARKER_FILENAME),
        JSON.stringify({ version: 1, libraryId: ULID_A, nonce: 'crash-nonce' }),
        'utf8',
      );
      h.journals.save({
        version: 1,
        libraryId: ULID_A,
        nonce: 'crash-nonce',
        sourcePath: h.sourceDir,
        destPath: destDir,
        stagingPath: `${destDir}.relocate-staging`,
        mode: 'rename',
        state: 'verified',
        startedAt: NOW().toISOString(),
      });
      renameSync(h.sourceDir, destDir); // the crash landed after the rename, before the registry commit

      const reports = await recoverRelocations(h.deps);

      assert.deepEqual(
        reports.map((report) => report.action),
        ['commit-completed'],
      );
      assert.equal(h.registry.get(ULID_A)?.path, destDir, 'registry rolled forward');
      assert.equal(readdirSync(join(h.root, 'disk'))[0], 'PHOTOS');
      assert.ok(!existsSync(join(destDir, RELOCATION_MARKER_FILENAME)), 'marker removed');
      assert.equal(h.journals.load(ULID_A), null);
    });

    test('REGRESSION (PR #846): crash AFTER the commit never deletes the library through its old-case alias', async () => {
      // The committed-cleanup path removes journal.sourcePath when it exists
      // and differs as a string — on a case-insensitive volume that alias IS
      // the renamed library. Recovery must finish cleanup without touching it.
      const h = harness('photos');
      const destDir = join(h.root, 'disk', 'PHOTOS');
      h.journals.save({
        version: 1,
        libraryId: ULID_A,
        nonce: 'crash-nonce',
        sourcePath: h.sourceDir,
        destPath: destDir,
        stagingPath: `${destDir}.relocate-staging`,
        mode: 'rename',
        state: 'verified',
        startedAt: NOW().toISOString(),
      });
      renameSync(h.sourceDir, destDir);
      h.registry.updatePath(ULID_A, destDir); // the crash landed after the registry commit

      const reports = await recoverRelocations(h.deps);

      assert.deepEqual(
        reports.map((report) => report.action),
        ['commit-completed'],
      );
      assert.ok(existsSync(join(destDir, 'library.db')), 'the library survived committed cleanup');
      assert.equal(readFileSync(join(destDir, 'library-id'), 'utf8'), LIB_FILES['library-id']);
      assert.equal(h.registry.get(ULID_A)?.path, destDir);
      assert.equal(h.journals.load(ULID_A), null, 'journal cleared');
    });

    test('crash before the rename → discarded, marker removed, registry untouched', async () => {
      const h = harness('photos');
      const destDir = join(h.root, 'disk', 'PHOTOS');
      writeFileSync(
        join(h.sourceDir, RELOCATION_MARKER_FILENAME),
        JSON.stringify({ version: 1, libraryId: ULID_A, nonce: 'crash-nonce' }),
        'utf8',
      );
      h.journals.save({
        version: 1,
        libraryId: ULID_A,
        nonce: 'crash-nonce',
        sourcePath: h.sourceDir,
        destPath: destDir,
        stagingPath: `${destDir}.relocate-staging`,
        mode: 'rename',
        state: 'verified',
        startedAt: NOW().toISOString(),
      });

      const reports = await recoverRelocations(h.deps);

      assert.deepEqual(
        reports.map((report) => report.action),
        ['discarded'],
      );
      assert.equal(h.registry.get(ULID_A)?.path, h.sourceDir, 'registry untouched');
      assert.equal(readdirSync(join(h.root, 'disk'))[0], 'photos', 'directory keeps its original case');
      assert.ok(!existsSync(join(h.sourceDir, RELOCATION_MARKER_FILENAME)), 'marker removed');
      assert.equal(h.journals.load(ULID_A), null);
    });
  });

  describe('runtime rename wrapper', () => {
    function runtimeHarness(): { runtime: RelocationRuntime; registry: LibraryRegistry; root: string; sourceDir: string } {
      const h = harness();
      const runtime = new RelocationRuntime({
        engineDeps: h.deps,
        active: {
          openLibraryId: () => null,
          lockState: () => 'unlocked',
          providerBusy: () => false,
          closeLibrary: () => Promise.resolve(),
          reactivate: () => Promise.resolve(),
        },
        emitProgress: () => undefined,
      });
      return { runtime, registry: h.registry, root: h.root, sourceDir: h.sourceDir };
    }

    test('an invalid name refuses with invalid-destination before anything runs', async () => {
      const { runtime, registry, sourceDir } = runtimeHarness();
      for (const bad of ['photos/2026', 'CON', 'ends.', ' leading']) {
        const outcome = await runtime.rename(ULID_A, bad);
        assert.ok(!outcome.ok, `"${bad}" refused`);
        assert.equal(outcome.reason, 'invalid-destination');
      }
      assert.equal(registry.get(ULID_A)?.path, sourceDir);
    });

    test('renaming to the identical name refuses honestly; a case-only change is allowed through', async () => {
      const { runtime } = runtimeHarness();
      const same = await runtime.rename(ULID_A, 'My Library');
      assert.ok(!same.ok);
      assert.equal(same.reason, 'invalid-destination');
      assert.match(same.detail, /already has this name/);

      const cased = await runtime.rename(ULID_A, 'MY LIBRARY');
      assert.ok(cased.ok, 'case-only rename goes through the engine');
      assert.equal(cased.mode, 'rename');
    });

    test('an unregistered library refuses with io-error', async () => {
      const { runtime } = runtimeHarness();
      const outcome = await runtime.rename(ULID_B, 'Whatever');
      assert.ok(!outcome.ok);
      assert.equal(outcome.reason, 'io-error');
    });

    test('EXIT CRITERIA: a valid rename lands the sibling destination with id, content, and registry agreeing', async () => {
      const { runtime, registry, root } = runtimeHarness();
      const outcome = await runtime.rename(ULID_A, 'Renamed Library');
      assert.ok(outcome.ok);
      assert.equal(outcome.outcome, 'moved');
      const expected = join(root, 'disk', 'Renamed Library');
      assert.equal(outcome.destPath, expected);
      assert.equal(registry.get(ULID_A)?.path, expected);
      assert.equal(readFileSync(join(expected, 'library-id'), 'utf8'), LIB_FILES['library-id']);
    });
  });
});
