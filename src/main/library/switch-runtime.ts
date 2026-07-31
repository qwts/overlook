import type { LibraryRegistryRuntime } from './library-registry-runtime.js';
import type { LibraryDescriptor } from '../../shared/library/registry.js';

// Live library switch (#385, ADR-0017 §4): guards → stamp selection → full
// teardown → repoint → swap the app-lock controller → reload the renderer.
// The selection is stamped BEFORE teardown on purpose: a crash anywhere
// mid-switch leaves the registry pointing at the target, so the relaunch
// opens it and the interrupted library recovers via WAL + journals on its
// next open (acceptance 3).
//
// Designed refusals are RETURNED, not thrown (#386): the switcher renders
// them as recoverable banners, and IPC strips thrown errors to bare codes.

export type SwitchRefusalReason = 'switch-in-progress' | 'locked' | 'provider-busy' | 'locked-elsewhere' | 'missing';

export type SwitchOutcome =
  | { readonly ok: true; readonly library: LibraryDescriptor; readonly requiresRestart: boolean }
  | { readonly ok: false; readonly reason: SwitchRefusalReason; readonly host: string | null };

export interface SwitchLibraryDeps {
  readonly registry: Pick<LibraryRegistryRuntime, 'select'>;
  /** The currently ACTIVE (selected) library id — may differ from what is
   * open when nothing has opened yet. */
  readonly activeId: () => string;
  readonly openLibraryId: () => string | null;
  /** App-lock state, undefined before the controller exists. */
  readonly lockState: () => string | undefined;
  /** True while backup/restore provider work is in flight (ADR-0011 parity). */
  readonly providerBusy: () => boolean;
  /** Pre-flight target check (#386): missing directory or a live lock held by
   * another instance refuses BEFORE teardown — null clears the target. */
  readonly probeTarget: (id: string) => { reason: 'missing' | 'locked-elsewhere'; host: string | null } | null;
  /** Switch-mode teardown: everything closeLibraryForLock does except the
   * window reload, which happens after the app-lock swap below. */
  readonly closeLibrary: () => Promise<void>;
  /** Rebind settings/provider state after the registry points at the target
   * and before any target-bound controller or renderer can observe it. */
  readonly activateLibrary: () => void;
  /** Rebuilds the dataDir-bound app-lock controller for the new library. */
  readonly swapAppLock: () => Promise<void>;
  readonly reloadWindows: () => Promise<void>;
  /** OVERLOOK_SWITCH_FAULT harness hook ('after-close' kills the process
   * between teardown and reopen — the crash-mid-switch E2E). */
  readonly fault: () => string | undefined;
  readonly exit: (code: number) => void;
}

export function createSwitchLibrary(deps: SwitchLibraryDeps): (id: string) => Promise<SwitchOutcome> {
  let switching = false;
  return async (id) => {
    if (switching) {
      return { ok: false, reason: 'switch-in-progress', host: null };
    }
    const lockState = deps.lockState();
    const authorized = lockState === undefined || lockState === 'unconfigured-unlocked' || lockState === 'unlocked';
    const stableClosedLockScreen = (lockState === 'locked' || lockState === 'recovery-required') && deps.openLibraryId() === null;
    if (!authorized && !stableClosedLockScreen) {
      return { ok: false, reason: 'locked', host: null };
    }
    if (deps.providerBusy()) {
      return { ok: false, reason: 'provider-busy', host: null };
    }
    const refused = deps.probeTarget(id);
    if (refused !== null) {
      return { ok: false, reason: refused.reason, host: refused.host };
    }
    // Validates the target (registered, directory present) and stamps
    // lastOpenedAt — the crash-safety anchor described above.
    const previousActiveId = deps.activeId();
    const selected = deps.registry.select(id, deps.openLibraryId());
    if (!selected.requiresRestart) {
      // Same library, or nothing open yet — no teardown. But a repoint
      // before first open still moves the app-lock boundary: the host was
      // initialized against the previous directory, and a lock-configured
      // target must land on ITS lock screen (PR #425 review).
      if (selected.library.id !== previousActiveId) {
        deps.activateLibrary();
        await deps.swapAppLock();
        await deps.reloadWindows();
      }
      return { ok: true, library: selected.library, requiresRestart: false };
    }
    switching = true;
    try {
      await deps.closeLibrary();
      if (deps.fault() === 'after-close') deps.exit(1);
      // Nothing is open now: re-select repoints the runtime's active entry.
      const repointed = deps.registry.select(id, null);
      deps.activateLibrary();
      await deps.swapAppLock();
      await deps.reloadWindows();
      return { ok: true, library: repointed.library, requiresRestart: false };
    } finally {
      switching = false;
    }
  };
}
