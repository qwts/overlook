import path from 'node:path';

import { BrowserWindow, app } from 'electron';

import { createSwitchLibrary } from './switch-runtime.js';
import type { AppLockHost } from '../crypto/app-lock-host.js';
import { LibraryRegistryError } from './library-registry.js';
import { recoverRelocations, type RelocationDeps } from './relocation-engine.js';
import { RelocationJournalStore } from './relocation-journal.js';
import { RelocationRuntime } from './relocation-runtime.js';
import { verifyStagedLibrary } from './relocation-verify.js';
import { classifyVolume } from './volume-info.js';
import type { LibraryRegistryRuntime } from './library-registry-runtime.js';
import type { SafeStorageLike } from '../crypto/keystore.js';
import { createEmitter } from '../../shared/ipc/registry.js';
import { events } from '../../shared/ipc/channels.js';

// Switch + relocation wiring (#385/#483), extracted from the composition root
// (index.ts sits at the 800-line budget). Both runtimes share the same
// closures — teardown, rebind, app-lock swap, renderer reload — so one deps
// bag builds both, and the relocation runtime's reactivate is composed from
// the switch's own tail sequence (ADR-0017 §4 / ADR-0022 §4).

export interface LibraryLifecycleDeps {
  readonly registryRuntime: LibraryRegistryRuntime;
  readonly instanceId: string;
  readonly safeStorage: () => SafeStorageLike;
  readonly activeId: () => string;
  readonly openLibraryId: () => string | null;
  readonly lockState: () => string | undefined;
  readonly providerBusy: () => boolean;
  /** Switch-mode ADR-0017 §4 teardown. */
  readonly closeLibrary: () => Promise<void>;
  /** Rebind settings to wherever the registry points. */
  readonly activateSettings: () => void;
  readonly resetProviderBinding: () => void;
  /** The live host (undefined before the controller exists) + a fresh
   * dataDir-bound controller for the swap after a re-point. */
  readonly appLockHost: () => AppLockHost | undefined;
  readonly buildAppLockController: () => Parameters<AppLockHost['swap']>[0];
  readonly reloadWindows: () => Promise<void>;
  /** Harness env reader: OVERLOOK_SWITCH_FAULT (crash-mid-switch E2E),
   * OVERLOOK_RELOCATION_FAULT (#483 acceptance 6), and
   * OVERLOOK_RELOCATION_FORCE_COPY (exercise the copy path on one volume —
   * E2E cannot mount a second filesystem in CI). */
  readonly harnessEnv: (name: string) => string | undefined;
}

export interface LibraryLifecycle {
  readonly switchLibrary: ReturnType<typeof createSwitchLibrary>;
  readonly getRelocationRuntime: () => RelocationRuntime;
  /** Settles relocation journals (ADR-0022 §2) — must run before anything
   * resolves or opens a library, because recovery may re-point the registry.
   * A corrupt registry is swallowed here: resolveFailure() reports it loud
   * immediately after. */
  readonly settleRelocationJournals: () => Promise<void>;
}

export function createLibraryLifecycle(deps: LibraryLifecycleDeps): LibraryLifecycle {
  const activateLibrary = (): void => {
    deps.activateSettings();
    deps.resetProviderBinding();
  };
  const swapAppLock = async (): Promise<void> => {
    const host = deps.appLockHost();
    if (host !== undefined) await host.swap(deps.buildAppLockController());
  };
  const switchLibrary = createSwitchLibrary({
    registry: deps.registryRuntime,
    activeId: deps.activeId,
    openLibraryId: deps.openLibraryId,
    lockState: deps.lockState,
    providerBusy: deps.providerBusy,
    probeTarget: (id) => deps.registryRuntime.probeSwitchTarget(id),
    closeLibrary: deps.closeLibrary,
    activateLibrary,
    swapAppLock,
    reloadWindows: deps.reloadWindows,
    fault: () => deps.harnessEnv('OVERLOOK_SWITCH_FAULT'),
    exit: (code) => app.exit(code),
  });

  // Journals live in the profile root so recovery still runs when the
  // destination volume is unplugged (ADR-0022 §2). The staged-custody probe
  // lives in relocation-verify.ts (covered; the runtime requires OVLK custody
  // to be actively authenticated before relocation).
  const engineDeps = (): RelocationDeps => ({
    journals: new RelocationJournalStore(path.join(app.getPath('userData'), 'relocations')),
    registry: deps.registryRuntime.getRegistry(),
    instanceId: deps.instanceId,
    verifyOpenable: (dir) => verifyStagedLibrary(deps.safeStorage, dir),
    // ADR-0022 §5 filesystem preflight: FAT32 blocks (4 GB cap); network
    // mounts warn-don't-block (ADR-0017 §5) via the probe channel.
    unsupportedFilesystem: (dir) => classifyVolume(dir).blocked,
    networkVolume: (dir) => classifyVolume(dir).network,
    fault: () => deps.harnessEnv('OVERLOOK_RELOCATION_FAULT'),
    // app.exit/process.exit route through Chromium's message loop in the
    // main process, and a fast microtask chain outruns the posted quit — the
    // "crash" would land several protocol steps late. SIGKILL to self is the
    // only deterministic boundary kill (#483 acceptance 6).
    exit: (code: number): never => {
      process.kill(process.pid, 'SIGKILL');
      return process.exit(code);
    },
    ...(deps.harnessEnv('OVERLOOK_RELOCATION_FORCE_COPY') === '1' ? { sameVolume: () => false } : {}),
  });

  const emitProgress = createEmitter(events.relocationProgress, (name, payload) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(name, payload);
  });

  let runtime: RelocationRuntime | undefined;
  const getRelocationRuntime = (): RelocationRuntime => {
    runtime ??= new RelocationRuntime({
      engineDeps: engineDeps(),
      active: {
        openLibraryId: deps.openLibraryId,
        lockState: deps.lockState,
        providerBusy: deps.providerBusy,
        closeLibrary: deps.closeLibrary,
        // The switch's own tail: re-point → rebind → swap app lock → reload.
        // The registry decides where the reopen lands (destination after a
        // commit, the untouched source after any refusal or failure).
        reactivate: async (id) => {
          deps.registryRuntime.select(id, null);
          activateLibrary();
          await swapAppLock();
          await deps.reloadWindows();
        },
      },
      emitProgress,
    });
    return runtime;
  };

  const settleRelocationJournals = async (): Promise<void> => {
    try {
      for (const report of await recoverRelocations(engineDeps())) {
        if (
          report.action !== 'cleanup-finished' &&
          report.action !== 'discarded' &&
          report.action !== 'commit-completed' &&
          report.action !== 'resume-available'
        ) {
          console.error('[overlook] relocation recovery', report.libraryId, report.action, report.detail ?? '');
        }
      }
    } catch (error) {
      if (!(error instanceof LibraryRegistryError)) throw error;
    }
  };

  return { switchLibrary, getRelocationRuntime, settleRelocationJournals };
}
