import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibraryRegistry, LibraryRegistryError, ensureDefaultEntry } from '../../src/main/library/library-registry.js';
import { LibraryRegistryRuntime } from '../../src/main/library/library-registry-runtime.js';
import { channels } from '../../src/shared/ipc/channels.js';
import { wrapHandler } from '../../src/shared/ipc/registry.js';
import { libraryRegistryFileSchema, selectStartupLibrary, type LibraryEntry } from '../../src/shared/library/registry.js';

// #384 / ADR-0017 §1/§7: standalone fail-loud registry with atomic writes,
// registry-only removal, and the register-in-place legacy migration.

const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const ULID_B = '01BRZ3NDEKTSV4RRFFQ69G5FAB';

function entry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id: ULID_A,
    name: 'My Library',
    path: '/tmp/lib-a',
    createdAt: '2026-07-16T00:00:00.000Z',
    lastOpenedAt: null,
    ...overrides,
  };
}

function registryIn(dir: string): LibraryRegistry {
  return new LibraryRegistry({ filePath: join(dir, 'libraries.json'), now: () => new Date('2026-07-16T12:00:00.000Z') });
}

describe('library registry (#384)', () => {
  test('the shared schema rejects duplicate library ids', () => {
    const duplicate = entry();
    assert.equal(libraryRegistryFileSchema.safeParse({ version: 1, entries: [duplicate, duplicate] }).success, false);
  });
  test('an absent file is an empty registry, not an error', () => {
    const registry = registryIn(mkdtempSync(join(tmpdir(), 'overlook-registry-')));
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.startupEntry(), undefined);
  });

  test('EXIT CRITERIA: entries persist across restart with atomic tmp+rename semantics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-registry-'));
    registryIn(dir).register(entry());

    assert.ok(existsSync(join(dir, 'libraries.json')));
    assert.ok(!existsSync(join(dir, 'libraries.json.tmp')), 'staging file is renamed away');
    const reborn = registryIn(dir);
    assert.equal(reborn.list().length, 1);
    assert.equal(reborn.get(ULID_A)?.name, 'My Library');
  });

  test('custody hints persist conservatively for sealed-library preflight (#729)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-registry-'));
    const registry = registryIn(dir);
    registry.register(entry());
    registry.updateCustodyHints(ULID_A, [{ providerId: 'pcloud', accountId: '42', soleCustodyItems: 2, soleCustodyBytes: 30 }]);
    assert.deepEqual(registryIn(dir).get(ULID_A)?.custodyHints, [
      { providerId: 'pcloud', accountId: '42', soleCustodyItems: 2, soleCustodyBytes: 30 },
    ]);
  });

  test('EXIT CRITERIA: a corrupt registry fails loud — never self-heals to empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-registry-'));
    writeFileSync(join(dir, 'libraries.json'), '{ not json', 'utf8');
    assert.throws(() => registryIn(dir), LibraryRegistryError);

    // Parseable but invalid is equally corrupt (a truncated rewrite, a wrong
    // schema) — silently dropping entries here is the failure mode ADR-0017
    // §1 forbids.
    writeFileSync(join(dir, 'libraries.json'), JSON.stringify({ version: 1, entries: [{ id: 'nope' }] }), 'utf8');
    assert.throws(() => registryIn(dir), LibraryRegistryError);
    assert.match(readFileSync(join(dir, 'libraries.json'), 'utf8'), /nope/, 'the corrupt file is left in place for recovery');
  });

  test('duplicate ids and duplicate resolved paths are rejected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-registry-'));
    const registry = registryIn(dir);
    registry.register(entry());
    assert.throws(() => registry.register(entry({ name: 'Again' })), LibraryRegistryError);
    assert.throws(
      () => registry.register(entry({ id: ULID_B, path: '/tmp/../tmp/lib-a' })),
      LibraryRegistryError,
      'path clash detected through normalization',
    );
  });

  test('EXIT CRITERIA: remove forgets the entry and touches nothing on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-registry-'));
    const libraryDir = join(dir, 'the-library');
    mkdirSync(libraryDir, { recursive: true });
    writeFileSync(join(libraryDir, 'library.db'), 'not-really-a-db', 'utf8');
    writeFileSync(join(libraryDir, 'master.key'), 'wrapped', 'utf8');

    const registry = registryIn(dir);
    registry.register(entry({ path: libraryDir }));
    assert.equal(registry.remove(ULID_A), true);
    assert.equal(registry.remove(ULID_A), false, 'second remove is a no-op');
    assert.deepEqual(registry.list(), []);
    assert.ok(existsSync(join(libraryDir, 'library.db')), 'database intact');
    assert.ok(existsSync(join(libraryDir, 'master.key')), 'key custody intact');
  });

  test('touchOpened stamps lastOpenedAt and drives startup selection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-registry-'));
    const registry = registryIn(dir);
    registry.register(entry());
    registry.register(entry({ id: ULID_B, path: '/tmp/lib-b', name: 'Second' }));

    registry.touchOpened(ULID_B);
    assert.equal(registry.startupEntry()?.id, ULID_B, 'most recently opened wins');
    assert.equal(registryIn(dir).startupEntry()?.id, ULID_B, 'selection survives restart');
    assert.throws(() => registry.touchOpened('01CRZ3NDEKTSV4RRFFQ69G5FAC'), LibraryRegistryError);
  });

  test('startup selection is deterministic: opened beats never-opened, then createdAt, then id', () => {
    const never = entry({ id: ULID_A, createdAt: '2026-07-01T00:00:00.000Z' });
    const opened = entry({ id: ULID_B, path: '/tmp/lib-b', lastOpenedAt: '2026-07-02T00:00:00.000Z' });
    assert.equal(selectStartupLibrary([never, opened])?.id, ULID_B);
    assert.equal(selectStartupLibrary([never, entry({ id: ULID_B, createdAt: '2026-07-03T00:00:00.000Z' })])?.id, ULID_B);
    assert.equal(selectStartupLibrary([never])?.id, ULID_A);
    assert.equal(selectStartupLibrary([]), undefined);
  });

  test('REGRESSION: same-id select refreshes the cached path after a relocation commit (PR #553 review)', () => {
    const userData = mkdtempSync(join(tmpdir(), 'overlook-registry-reloc-'));
    const runtime = new LibraryRegistryRuntime({ userDataDir: () => userData });
    const sourceDir = join(userData, 'lib-src');
    const destDir = join(userData, 'lib-dest');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(destDir, { recursive: true });
    runtime.getRegistry().register({
      id: ULID_A,
      name: 'Lib',
      path: sourceDir,
      createdAt: '2026-07-19T00:00:00.000Z',
      lastOpenedAt: '2026-07-19T00:00:00.000Z',
    });
    assert.equal(runtime.resolveActive().path, sourceDir, 'cache primed at the source');

    // The ADR-0022 §4 commit rewrites the path under an unchanged id; the
    // post-move reactivation select must serve the registry truth, not the
    // cached object bound to the (now deleted) source.
    runtime.getRegistry().updatePath(ULID_A, destDir);
    const selected = runtime.select(ULID_A, null);
    assert.equal(selected.library.path, destDir, 'select serves the registry truth');
    assert.equal(runtime.dataDir(), destDir, 'runtime rebinds to the destination');
  });

  test('REGRESSION: a fresh profile resolves without touching disk (restore needs a pristine target)', () => {
    const userData = mkdtempSync(join(tmpdir(), 'overlook-registry-'));
    const runtime = new LibraryRegistryRuntime({ userDataDir: () => userData });

    const virtual = runtime.resolveActive();
    assert.equal(runtime.dataDir(), join(userData, 'library'));
    assert.ok(!existsSync(join(userData, 'library')), 'no legacy directory created at resolution');
    assert.ok(!existsSync(join(userData, 'libraries.json')), 'no registry file written at resolution');
    assert.deepEqual(runtime.list(null), [], 'virtual default is not a registry entry');

    // First real open materializes it (§7): directory id pinned, entry registered.
    const opened = runtime.healActiveId();
    assert.equal(opened.id, virtual.id);
    assert.equal(readFileSync(join(userData, 'library', 'library-id'), 'utf8'), opened.id);
    assert.equal(runtime.list(null).length, 1);
  });

  test('REGRESSION: registering an existing library does not silently replace a resolved virtual default', () => {
    const userData = mkdtempSync(join(tmpdir(), 'overlook-registry-fresh-add-'));
    const runtime = new LibraryRegistryRuntime({ userDataDir: () => userData });
    const virtual = runtime.resolveActive();
    const existing = join(userData, 'retained-library');
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, 'library.db'), 'sqlcipher-bytes', 'utf8');

    const added = runtime.addExisting(existing, null);
    assert.equal(added.ok, true);
    assert.equal(runtime.resolveActive().id, virtual.id, 'registration alone cannot move the active app-lock boundary');
    if (!added.ok) return;

    const selected = runtime.select(added.library.id, null);
    assert.equal(selected.requiresRestart, false);
    assert.equal(runtime.resolveActive().id, added.library.id, 'explicit selection repoints the runtime');
  });

  function seedLegacyInstall(userData: string): void {
    mkdirSync(join(userData, 'library'), { recursive: true });
    writeFileSync(join(userData, 'library', 'library.db'), 'sqlcipher-bytes', 'utf8');
  }

  test('select stamps the choice, reports requiresRestart while another library is open, and refuses missing paths', () => {
    const userData = mkdtempSync(join(tmpdir(), 'overlook-registry-'));
    seedLegacyInstall(userData);
    const runtime = new LibraryRegistryRuntime({ userDataDir: () => userData });
    const first = runtime.resolveActive();
    const realDir = join(userData, 'second');
    mkdirSync(realDir, { recursive: true });
    const second = runtime.getRegistry().register(entry({ id: ULID_B, path: realDir, name: 'Second' }));
    const ghost = runtime.getRegistry().register(entry({ id: '01CRZ3NDEKTSV4RRFFQ69G5FAC', path: join(userData, 'gone'), name: 'Ghost' }));

    // Nothing open yet: selection re-points the active library in place.
    const idle = runtime.select(second.id, null);
    assert.equal(idle.requiresRestart, false);
    assert.equal(runtime.dataDir(), realDir);

    // A different library is open: selection persists but needs a restart
    // until #385 lands the live switch.
    const busy = runtime.select(first.id, second.id);
    assert.equal(busy.requiresRestart, true);

    assert.throws(() => runtime.select(ghost.id, null), LibraryRegistryError, 'missing directory refuses selection');
  });

  test('REGRESSION (PR #425): startup validation fails loud when the active registered directory is missing', () => {
    const userData = mkdtempSync(join(tmpdir(), 'overlook-registry-'));
    seedLegacyInstall(userData);
    const runtime = new LibraryRegistryRuntime({ userDataDir: () => userData });
    assert.equal(runtime.resolveFailure(), null, 'present directory passes the startup gate');

    rmSync(join(userData, 'library'), { recursive: true, force: true });
    const fresh = new LibraryRegistryRuntime({ userDataDir: () => userData });
    assert.match(
      fresh.resolveFailure() ?? '',
      /library directory is missing/,
      'unplugged volume is a startup error, never a "fresh profile"',
    );

    // A truly fresh profile (virtual default, nothing registered) still passes.
    const pristine = new LibraryRegistryRuntime({ userDataDir: () => mkdtempSync(join(tmpdir(), 'overlook-registry-')) });
    assert.equal(pristine.resolveFailure(), null);
  });

  test('addExisting (#386): registers a real library in place, refuses non-libraries and duplicates', () => {
    const userData = mkdtempSync(join(tmpdir(), 'overlook-registry-'));
    seedLegacyInstall(userData);
    const runtime = new LibraryRegistryRuntime({ userDataDir: () => userData });
    runtime.resolveActive();

    const plain = join(userData, 'not-a-library');
    mkdirSync(plain, { recursive: true });
    assert.deepEqual(runtime.addExisting(plain, null), { ok: false, reason: 'not-a-library' }, 'a directory without library.db refuses');

    const real = join(userData, 'external-lib');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'library.db'), 'sqlcipher-bytes', 'utf8');
    const added = runtime.addExisting(real, null);
    assert.equal(added.ok, true);
    if (added.ok) {
      assert.equal(added.library.name, 'external-lib', 'named after its directory');
      assert.equal(readFileSync(join(real, 'library-id'), 'utf8'), added.library.id, 'directory id pinned in place');
    }
    assert.deepEqual(runtime.addExisting(real, null), { ok: false, reason: 'already-registered' }, 'second add refuses');
  });

  test('lockedBy + probeSwitchTarget (#386): descriptors and pre-flight surface a live foreign lock', () => {
    const userData = mkdtempSync(join(tmpdir(), 'overlook-registry-'));
    seedLegacyInstall(userData);
    const lockedDirs = new Set<string>();
    const runtime = new LibraryRegistryRuntime({
      userDataDir: () => userData,
      lockHolder: (dir) => (lockedDirs.has(dir) ? 'MAC-B' : null),
    });
    const first = runtime.resolveActive();
    const other = join(userData, 'second');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'library.db'), 'sqlcipher-bytes', 'utf8');
    const second = runtime.getRegistry().register(entry({ id: ULID_B, path: other, name: 'Second' }));

    lockedDirs.add(other);
    const described = runtime.list(first.id).find((lib) => lib.id === second.id);
    assert.equal(described?.lockedBy, 'MAC-B', 'a foreign live lock is named on the descriptor');
    assert.equal(runtime.list(first.id).find((lib) => lib.id === first.id)?.lockedBy, null, 'the open library is never locked-elsewhere');
    assert.deepEqual(runtime.probeSwitchTarget(second.id), { reason: 'locked-elsewhere', host: 'MAC-B' });

    lockedDirs.delete(other);
    assert.equal(runtime.probeSwitchTarget(second.id), null, 'a free target clears pre-flight');
    rmSync(other, { recursive: true, force: true });
    assert.deepEqual(
      runtime.probeSwitchTarget(second.id),
      { reason: 'missing', host: null },
      'a vanished directory refuses before teardown',
    );
    assert.equal(runtime.probeSwitchTarget('01CRZ3NDEKTSV4RRFFQ69G5FAC'), null, 'unregistered ids fall through to select()');
  });

  test('removeEntry guards the open library and re-resolves a removed selection', () => {
    const userData = mkdtempSync(join(tmpdir(), 'overlook-registry-'));
    seedLegacyInstall(userData);
    const runtime = new LibraryRegistryRuntime({ userDataDir: () => userData });
    const first = runtime.resolveActive();
    assert.throws(() => runtime.removeEntry(first.id, first.id), LibraryRegistryError, 'the open library cannot be removed');
    assert.equal(runtime.removeEntry(first.id, null), true, 'removable once nothing has it open');
    assert.notEqual(runtime.resolveActive().path, '', 're-resolution yields a usable default');
  });

  test('IPC boundary: the open channel rejects a malformed library id at the schema', async () => {
    const handler = wrapHandler(channels.libraryRegistryOpen, () => {
      throw new Error('handler must not run');
    });
    assert.deepEqual(await handler({ id: 'not-a-ulid' }), {
      __overlookIpcFailure: true,
      error: { code: 'IPC_INVALID_REQUEST' },
    });
  });

  test('EXIT CRITERIA: migration registers the legacy directory in place, exactly once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-registry-'));
    const legacyDir = join(dir, 'library');
    const registry = registryIn(dir);

    let minted = 0;
    const options = {
      legacyDir,
      libraryId: () => {
        minted += 1;
        return ULID_A;
      },
    };
    const first = ensureDefaultEntry(registry, options);
    assert.equal(first.path, legacyDir);
    assert.equal(first.name, 'My Library');
    assert.equal(minted, 1);

    const again = ensureDefaultEntry(registry, options);
    assert.equal(again.id, first.id, 'idempotent — an existing entry short-circuits');
    assert.equal(minted, 1, 'no second id minted');
    assert.equal(registry.list().length, 1);
  });
});
