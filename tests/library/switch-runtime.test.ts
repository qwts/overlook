import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createSwitchLibrary, type SwitchLibraryDeps } from '../../src/main/library/switch-runtime.js';
import type { LibraryDescriptor } from '../../src/shared/library/registry.js';

// #385 / ADR-0017 §4: switch guards, ordering, and the crash-safety anchor
// (selection stamped before teardown). #386: refusals are returned outcomes.

function descriptor(id: string): LibraryDescriptor {
  return {
    id,
    name: 'Lib',
    path: `/tmp/${id}`,
    createdAt: '2026-07-17T00:00:00.000Z',
    lastOpenedAt: null,
    missing: false,
    open: false,
    lockedBy: null,
  };
}

const A = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const B = '01BRZ3NDEKTSV4RRFFQ69G5FAB';

interface Harness {
  readonly deps: SwitchLibraryDeps;
  readonly calls: string[];
}

function harness(overrides: Partial<Record<keyof SwitchLibraryDeps, unknown>> = {}): Harness {
  const calls: string[] = [];
  const deps: SwitchLibraryDeps = {
    registry: {
      select: (id, openId) => {
        calls.push(`select:${id}:${openId ?? 'null'}`);
        return { library: descriptor(id), requiresRestart: openId !== null && openId !== id };
      },
    },
    activeId: () => A,
    openLibraryId: () => A,
    lockState: () => 'unconfigured-unlocked',
    providerBusy: () => false,
    probeTarget: () => null,
    closeLibrary: () => {
      calls.push('close');
      return Promise.resolve();
    },
    activateLibrary: () => calls.push('activate'),
    swapAppLock: () => {
      calls.push('swap');
      return Promise.resolve();
    },
    reloadWindows: () => {
      calls.push('reload');
      return Promise.resolve();
    },
    fault: () => undefined,
    exit: (code) => calls.push(`exit:${String(code)}`),
    ...(overrides as Partial<SwitchLibraryDeps>),
  };
  return { deps, calls };
}

describe('switch runtime (#385)', () => {
  test('ACCEPTANCE: full switch runs stamp → teardown → repoint → app-lock swap → reload, in order', async () => {
    const { deps, calls } = harness();
    const result = await createSwitchLibrary(deps)(B);

    assert.deepEqual(calls, [`select:${B}:${A}`, 'close', `select:${B}:null`, 'activate', 'swap', 'reload']);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.requiresRestart, false);
      assert.equal(result.library.id, B);
    }
  });

  test('selection is stamped BEFORE teardown — the crash-safety anchor', async () => {
    const { deps, calls } = harness();
    await createSwitchLibrary(deps)(B);
    assert.ok(
      calls.indexOf(`select:${B}:${A}`) < calls.indexOf('close'),
      'a crash during close still leaves the registry pointing at the target',
    );
  });

  test('same library completes by selection alone — no teardown, no swap', async () => {
    const same = harness();
    await createSwitchLibrary(same.deps)(A);
    assert.deepEqual(same.calls, [`select:${A}:${A}`], 'same id: selection only');
  });

  test('a repoint before first open skips teardown but still swaps app-lock and reloads (PR #425 review)', async () => {
    const idle = harness({ openLibraryId: () => null });
    await createSwitchLibrary(idle.deps)(B);
    assert.deepEqual(
      idle.calls,
      [`select:${B}:null`, 'activate', 'swap', 'reload'],
      'the app-lock boundary follows the new directory — a lock-configured target lands on ITS lock screen',
    );
  });

  test('refusals return typed outcomes (#386): live locked, provider busy, already switching — nothing is stamped', async () => {
    const locked = harness({ lockState: () => 'locked' });
    assert.deepEqual(await createSwitchLibrary(locked.deps)(B), { ok: false, reason: 'locked', host: null });
    assert.deepEqual(locked.calls, [], 'refusal happens before anything is stamped');

    const busy = harness({ providerBusy: () => true });
    assert.deepEqual(await createSwitchLibrary(busy.deps)(B), { ok: false, reason: 'provider-busy', host: null });
    assert.deepEqual(busy.calls, []);

    let releaseClose: () => void = () => undefined;
    const slow = harness({
      closeLibrary: () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        }),
    });
    const switchLibrary = createSwitchLibrary(slow.deps);
    const first = switchLibrary(B);
    assert.deepEqual(await switchLibrary(B), { ok: false, reason: 'switch-in-progress', host: null });
    releaseClose();
    await first;
  });

  test('ACCEPTANCE #847: a stable lock screen with no open library can repoint and rebind app-lock custody', async () => {
    for (const state of ['locked', 'recovery-required']) {
      const closed = harness({ lockState: () => state, openLibraryId: () => null });
      const result = await createSwitchLibrary(closed.deps)(B);
      assert.equal(result.ok, true, `${state} can leave the unavailable startup library`);
      assert.deepEqual(closed.calls, [`select:${B}:null`, 'activate', 'swap', 'reload']);
    }
  });

  test('ACCEPTANCE #847: transient app-lock states still refuse even when no library is open', async () => {
    for (const state of ['locking', 'unlocking']) {
      const transient = harness({ lockState: () => state, openLibraryId: () => null });
      assert.deepEqual(await createSwitchLibrary(transient.deps)(B), { ok: false, reason: 'locked', host: null });
      assert.deepEqual(transient.calls, []);
    }
  });

  test('the pre-flight probe refuses a missing or locked-elsewhere target BEFORE teardown (#386)', async () => {
    const missing = harness({ probeTarget: () => ({ reason: 'missing', host: null }) });
    assert.deepEqual(await createSwitchLibrary(missing.deps)(B), { ok: false, reason: 'missing', host: null });
    assert.deepEqual(missing.calls, [], 'the open library was never torn down');

    const elsewhere = harness({ probeTarget: () => ({ reason: 'locked-elsewhere', host: 'MAC-B' }) });
    assert.deepEqual(await createSwitchLibrary(elsewhere.deps)(B), { ok: false, reason: 'locked-elsewhere', host: 'MAC-B' });
    assert.deepEqual(elsewhere.calls, []);
  });

  test('an unconfigured or unlocked lock state allows switching', async () => {
    for (const state of ['unconfigured-unlocked', 'unlocked', undefined]) {
      const { deps, calls } = harness({ lockState: () => state });
      await createSwitchLibrary(deps)(B);
      assert.ok(calls.includes('close'), `state ${String(state)} switches`);
    }
  });

  test('OVERLOOK_SWITCH_FAULT=after-close kills the process between teardown and reopen', async () => {
    const { deps, calls } = harness({ fault: () => 'after-close' });
    await createSwitchLibrary(deps)(B);
    assert.ok(calls.indexOf('close') < calls.indexOf('exit:1'), 'fault fires after teardown');
    assert.ok(calls.indexOf('exit:1') < calls.indexOf(`select:${B}:null`), 'and before the repoint — the crash window the E2E exercises');
  });
});
