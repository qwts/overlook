import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibraryRegistry } from '../../src/main/library/library-registry.js';
import { RelocationError } from '../../src/main/library/relocation-engine.js';
import { RelocationJournalStore } from '../../src/main/library/relocation-journal.js';
import { RelocationRuntime, type RelocationRuntimeOptions } from '../../src/main/library/relocation-runtime.js';
import { channels } from '../../src/shared/ipc/channels.js';
import { wrapHandler } from '../../src/shared/ipc/registry.js';
import { RELOCATION_MARKER_FILENAME } from '../../src/shared/library/relocation.js';

// #483 / ADR-0022 §4 runtime wrapper: the active-library move runs the
// switch-shaped sequence and ALWAYS reactivates (the registry decides where
// the reopen lands); designed refusals are returned, never thrown; one move
// at a time; cancellation reaches the engine's signal.

const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const ULID_B = '01BRZ3NDEKTSV4RRFFQ69G5FAB';
const NOW = () => new Date('2026-07-19T12:00:00.000Z');

interface Harness {
  readonly runtime: RelocationRuntime;
  readonly registry: LibraryRegistry;
  readonly journals: RelocationJournalStore;
  readonly calls: string[];
  readonly root: string;
}

function harness(overrides: Partial<RelocationRuntimeOptions> = {}, active = false): Harness {
  const root = mkdtempSync(join(tmpdir(), 'overlook-reloc-runtime-'));
  const registry = new LibraryRegistry({ filePath: join(root, 'libraries.json'), now: NOW });
  registry.register({ id: ULID_A, name: 'My Library', path: join(root, 'lib-a'), createdAt: NOW().toISOString(), lastOpenedAt: null });
  // A real source directory: the active-move path dry-runs the §5 preflight
  // BEFORE teardown (PR #557 review), so the probe must have bytes to walk.
  mkdirSync(join(root, 'lib-a'), { recursive: true });
  writeFileSync(join(root, 'lib-a', 'library-id'), ULID_A, 'utf8');
  const journals = new RelocationJournalStore(join(root, 'relocations'));
  const calls: string[] = [];
  const runtime = new RelocationRuntime({
    engineDeps: { journals, registry, instanceId: 'test-instance' },
    active: {
      openLibraryId: () => (active ? ULID_A : null),
      lockState: () => 'unlocked',
      providerBusy: () => false,
      closeLibrary: () => {
        calls.push('close');
        return Promise.resolve();
      },
      reactivate: (id) => {
        calls.push(`reactivate:${id}`);
        return Promise.resolve();
      },
    },
    emitProgress: () => undefined,
    relocate: (deps, options) => {
      calls.push('relocate');
      deps.registry.updatePath(options.libraryId, options.destDir);
      return Promise.resolve({ outcome: 'moved' as const, mode: 'copy' as const, items: 5, bytes: 100 });
    },
    resume: (deps, options) => {
      calls.push('resume');
      const journal = deps.journals.load(options.libraryId);
      assert.ok(journal);
      deps.registry.updatePath(options.libraryId, journal.destPath);
      deps.journals.clear(options.libraryId);
      return Promise.resolve({ outcome: 'moved' as const, mode: 'copy' as const, items: 3, bytes: 60 });
    },
    discard: (_deps, id) => {
      calls.push(`discard:${id}`);
      return Promise.resolve('discarded' as const);
    },
    ...overrides,
  });
  return { runtime, registry, journals, calls, root };
}

describe('relocation runtime (#483, ADR-0022 §4)', () => {
  test('EXIT CRITERIA: active-library move runs teardown → relocate → reactivate, in that order', async () => {
    const h = harness({}, true);
    const dest = join(h.root, 'new-home');
    const outcome = await h.runtime.move(ULID_A, dest);
    assert.deepEqual(h.calls, ['close', 'relocate', `reactivate:${ULID_A}`]);
    assert.ok(outcome.ok);
    assert.equal(outcome.destPath, dest);
    assert.equal(outcome.sourcePath, join(h.root, 'lib-a'), 'both paths reported for the wizard');
  });

  test('a failed active move still reactivates — the registry points at the untouched source', async () => {
    const h = harness(
      {
        relocate: () => Promise.reject(new RelocationError('verification-failed', 'digest mismatch')),
      },
      true,
    );
    const outcome = await h.runtime.move(ULID_A, join(h.root, 'new-home'));
    assert.deepEqual(h.calls, ['close', `reactivate:${ULID_A}`], 'reopen happens on failure too');
    assert.ok(!outcome.ok);
    assert.equal(outcome.reason, 'verification-failed');
    assert.equal(outcome.detail, 'digest mismatch');
    assert.equal(h.registry.get(ULID_A)?.path, join(h.root, 'lib-a'));
  });

  test('an inactive move never touches teardown or reactivation', async () => {
    const h = harness();
    const outcome = await h.runtime.move(ULID_A, '/somewhere/new');
    assert.ok(outcome.ok);
    assert.deepEqual(h.calls, ['relocate']);
  });

  test('an unreadable custody probe refuses source-unreadable, never an opaque failure (PR #853 review)', async () => {
    const h = harness();
    // A directory in master.key's place makes the probe read throw (EISDIR).
    mkdirSync(join(h.root, 'lib-a', 'master.key'), { recursive: true });
    const outcome = await h.runtime.move(ULID_A, join(h.root, 'elsewhere'));
    assert.deepEqual(outcome, {
      ok: false,
      reason: 'source-unreadable',
      detail: `cannot read the library's custody files at ${join(h.root, 'lib-a')}`,
    });
    assert.deepEqual(h.calls, [], 'nothing tore down or relocated');
  });

  test('an inactive app-locked library must be opened and unlocked before moving', async () => {
    const h = harness();
    writeFileSync(join(h.root, 'lib-a', 'master.key'), 'OVLK-attacker-controlled-custody', 'utf8');

    const outcome = await h.runtime.move(ULID_A, '/somewhere/new');

    assert.ok(!outcome.ok);
    assert.equal(outcome.reason, 'app-locked');
    assert.deepEqual(h.calls, []);
    assert.equal(h.registry.get(ULID_A)?.path, join(h.root, 'lib-a'));
  });

  test('designed refusals: app-locked and provider-busy guard the active move', async () => {
    const locked = harness();
    const lockedRuntime = new RelocationRuntime({
      engineDeps: { journals: locked.journals, registry: locked.registry, instanceId: 'test' },
      active: {
        openLibraryId: () => ULID_A,
        lockState: () => 'locked',
        providerBusy: () => false,
        closeLibrary: () => assert.fail('must not tear down while locked'),
        reactivate: () => assert.fail('must not reactivate'),
      },
      emitProgress: () => undefined,
      relocate: () => assert.fail('must not relocate'),
    });
    const refusedLocked = await lockedRuntime.move(ULID_A, '/x');
    assert.ok(!refusedLocked.ok);
    assert.equal(refusedLocked.reason, 'app-locked');

    const busy = harness(
      {
        active: {
          openLibraryId: () => ULID_A,
          lockState: () => 'unlocked',
          providerBusy: () => true,
          closeLibrary: () => assert.fail('must not tear down while provider is busy'),
          reactivate: () => assert.fail('must not reactivate'),
        },
      },
      true,
    );
    const refusedBusy = await busy.runtime.move(ULID_A, '/x');
    assert.ok(!refusedBusy.ok);
    assert.equal(refusedBusy.reason, 'provider-busy');
  });

  test('one move at a time: a second move refuses while the first runs, works after', async () => {
    let releaseFirst: (() => void) | undefined;
    const h = harness({
      relocate: async (deps, options) => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        deps.registry.updatePath(options.libraryId, options.destDir);
        return { outcome: 'moved', mode: 'copy', items: 1, bytes: 1 };
      },
    });
    h.registry.register({ id: ULID_B, name: 'Other', path: join(h.root, 'lib-b'), createdAt: NOW().toISOString(), lastOpenedAt: null });

    const first = h.runtime.move(ULID_A, '/dest-a');
    const second = await h.runtime.move(ULID_B, '/dest-b');
    assert.ok(!second.ok);
    assert.equal(second.reason, 'move-in-progress');

    releaseFirst?.();
    assert.ok((await first).ok);
    // The gated fake parks every call — release the third move's gate too.
    const third = h.runtime.move(ULID_B, '/dest-b');
    releaseFirst?.();
    assert.ok((await third).ok, 'runs again once the slot frees');
  });

  test("cancel aborts the running move's signal — and only for the right library", async () => {
    let captured: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const h = harness({
      relocate: async (_deps, options) => {
        captured = options.signal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw new RelocationError('cancelled', 'relocation cancelled');
      },
    });
    const inFlight = h.runtime.move(ULID_A, '/dest');
    assert.equal(h.runtime.cancel(ULID_B), false, 'wrong id cancels nothing');
    assert.equal(h.runtime.cancel(ULID_A), true);
    assert.equal(captured?.aborted, true, 'abort reached the engine signal');
    release?.();
    const outcome = await inFlight;
    assert.ok(!outcome.ok);
    assert.equal(outcome.reason, 'cancelled');
    assert.equal(h.runtime.cancel(ULID_A), false, 'nothing left to cancel');
  });

  test('an ACTIVE-library preflight refusal returns before teardown — no reload eats the wizard retry (PR #557 review)', async () => {
    const h = harness(
      {
        relocate: () => assert.fail('must not reach the engine move'),
      },
      true,
    );
    // Real source dir + occupied destination: the pre-teardown probe refuses.
    mkdirSync(join(h.root, 'lib-a'), { recursive: true });
    writeFileSync(join(h.root, 'lib-a', 'library-id'), ULID_A, 'utf8');
    const dest = join(h.root, 'occupied');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'content'), 'x', 'utf8');

    const outcome = await h.runtime.move(ULID_A, dest);
    assert.ok(!outcome.ok);
    assert.equal(outcome.reason, 'destination-not-empty');
    assert.deepEqual(h.calls, [], 'no teardown, no reactivation, no reload');
  });

  test('a pending journal blocks a fresh move before active teardown', async () => {
    const h = harness({}, true);
    h.journals.save({
      version: 1,
      libraryId: ULID_A,
      nonce: 'resume-nonce',
      sourcePath: join(h.root, 'lib-a'),
      destPath: join(h.root, 'old-destination'),
      stagingPath: join(h.root, 'old-destination.relocate-staging'),
      mode: 'copy',
      state: 'copying',
      startedAt: NOW().toISOString(),
    });

    const outcome = await h.runtime.move(ULID_A, join(h.root, 'new-destination'));

    assert.ok(!outcome.ok);
    assert.equal(outcome.reason, 'move-in-progress');
    assert.match(outcome.detail, /resume or discard it first/);
    assert.deepEqual(h.calls, [], 'pending move is refused before teardown or relocation');
    assert.equal(h.journals.load(ULID_A)?.destPath, join(h.root, 'old-destination'));
  });

  test('pending() surfaces journals — corrupt ones with null fields, never guessed at', () => {
    const h = harness();
    h.journals.save({
      version: 1,
      libraryId: ULID_A,
      nonce: 'n',
      sourcePath: '/a',
      destPath: '/b',
      stagingPath: '/b.relocate-staging',
      mode: 'copy',
      state: 'committed',
      startedAt: NOW().toISOString(),
    });
    mkdirSync(join(h.root, 'relocations'), { recursive: true });
    writeFileSync(join(h.root, 'relocations', `${ULID_B}.json`), '{ not json', 'utf8');

    const pending = h.runtime.pending().sort((a, b) => (a.libraryId < b.libraryId ? -1 : 1));
    assert.deepEqual(pending, [
      { libraryId: ULID_A, state: 'committed', sourcePath: '/a', destPath: '/b', corrupt: false, resumable: false },
      { libraryId: ULID_B, state: null, sourcePath: null, destPath: null, corrupt: true, resumable: false },
    ]);
  });

  test('resume uses the move slot and active-library teardown/reactivation; discard stays destination-only', async () => {
    const h = harness({}, true);
    const destPath = join(h.root, 'new-home');
    const stagingPath = `${destPath}.relocate-staging`;
    h.journals.save({
      version: 1,
      libraryId: ULID_A,
      nonce: 'resume-nonce',
      sourcePath: join(h.root, 'lib-a'),
      destPath,
      stagingPath,
      mode: 'copy',
      state: 'copying',
      startedAt: NOW().toISOString(),
    });
    mkdirSync(stagingPath, { recursive: true });
    writeFileSync(
      join(stagingPath, RELOCATION_MARKER_FILENAME),
      JSON.stringify({ version: 1, libraryId: ULID_A, nonce: 'resume-nonce' }),
      'utf8',
    );

    assert.equal(h.runtime.pending()[0]?.resumable, true);
    const outcome = await h.runtime.resume(ULID_A);
    assert.ok(outcome.ok);
    assert.deepEqual(h.calls, ['close', 'resume', `reactivate:${ULID_A}`]);
    assert.equal(outcome.sourcePath, join(h.root, 'lib-a'));
    assert.equal(outcome.destPath, destPath);

    assert.equal(await h.runtime.discard(ULID_A), 'discarded');
    assert.equal(h.calls.at(-1), `discard:${ULID_A}`);
  });

  test('EXIT CRITERIA: responses round-trip the zod channel contracts', async () => {
    const h = harness();
    const moved = await wrapHandler(channels.libraryRelocationMove, ({ id, destPath }) => h.runtime.move(id, destPath))({
      id: ULID_A,
      destPath: '/channel-dest',
    });
    assert.deepEqual(moved, {
      ok: true,
      outcome: 'moved',
      mode: 'copy',
      items: 5,
      bytes: 100,
      sourcePath: join(h.root, 'lib-a'),
      destPath: '/channel-dest',
    });
    const pending = await wrapHandler(channels.libraryRelocationPending, () => ({ pending: h.runtime.pending() }))({});
    assert.deepEqual(pending, { pending: [] });
    const cancel = await wrapHandler(channels.libraryRelocationCancel, ({ id }) => ({ cancelled: h.runtime.cancel(id) }))({ id: ULID_A });
    assert.deepEqual(cancel, { cancelled: false });
    const discarded = await wrapHandler(channels.libraryRelocationDiscard, ({ id }) =>
      h.runtime.discard(id).then((result) => ({ result })),
    )({
      id: ULID_A,
    });
    assert.deepEqual(discarded, { result: 'discarded' });
  });
});
