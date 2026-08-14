import { app } from 'electron';

import path from 'node:path';

import { RestoreRuntime } from './restore-runtime.js';
import { activationOperationsForHarness } from './restore-fault.js';
import { AppLockCredentialStore, type CredentialAnchorStore } from '../crypto/app-lock-credentials.js';
import { OsCredentialAnchorStore } from '../crypto/credential-anchor.js';
import { TestFileCredentialAnchorStore } from '../crypto/test-credential-anchor.js';
import type { SafeStorageLike } from '../crypto/keystore.js';

// RestoreRuntime wiring (#291), extracted from the composition root.
// Activation does not quit the process (#994): the complete screen is the
// recovery result. The harness OVERLOOK_RESTORE_NO_RELAUNCH flag is kept so
// existing tests still opt out of a no-op.

export interface RestoreRuntimeFactoryOptions {
  readonly targetDir: string;
  readonly safeStorage: () => SafeStorageLike;
  /** May throw when no library keystore is open — normalized to null here. */
  readonly localMasterKey?: (() => Buffer | null) | undefined;
  readonly sources: ConstructorParameters<typeof RestoreRuntime>[0]['sources'];
  readonly sessionId: () => string;
  readonly progress: ConstructorParameters<typeof RestoreRuntime>[0]['progress'];
  readonly statusChanged?: ConstructorParameters<typeof RestoreRuntime>[0]['statusChanged'];
  readonly beforeActivate: () => Promise<void>;
  readonly harnessEnv: (name: string) => string | undefined;
  readonly workChanged: (delta: 1 | -1) => void;
}

/** Mirrors buildAppLockController's anchor-store selection (#753/#754): the
 * store activation touches is the one the relaunched lock controller reads. */
function lockAnchorStore(options: RestoreRuntimeFactoryOptions): CredentialAnchorStore {
  return options.harnessEnv('OVERLOOK_APP_LOCK_TEST_ANCHOR') === '1'
    ? new TestFileCredentialAnchorStore(path.join(app.getPath('userData'), 'app-lock-test-anchor.json'))
    : new OsCredentialAnchorStore({ dataDir: options.targetDir });
}

export function createRestoreRuntime(options: RestoreRuntimeFactoryOptions): RestoreRuntime {
  return new RestoreRuntime({
    targetDir: options.targetDir,
    workerUrl: new URL('./thumbnail-worker.js', import.meta.url),
    safeStorage: options.safeStorage,
    localMasterKey:
      options.localMasterKey === undefined
        ? undefined
        : () => {
            try {
              return options.localMasterKey?.() ?? null;
            } catch {
              return null;
            }
          },
    sources: options.sources,
    sessionId: options.sessionId,
    progress: options.progress,
    statusChanged: options.statusChanged,
    beforeActivate: options.beforeActivate,
    activationOperations: activationOperationsForHarness(options.harnessEnv('OVERLOOK_RESTORE_FAULT')),
    // Mirrors buildAppLockController's store selection (#753): the anchor the
    // lock will consult on relaunch is the one activation must reconcile.
    resetLockAnchor: () => {
      const store = lockAnchorStore(options);
      store.clear();
      // clear() discards the credential-tool exit status (PR #756 review):
      // verify the anchor is actually gone so a refused delete surfaces as a
      // loud logged failure instead of a silent relaunch into Recovery
      // required. Mirrors AppLockCredentialStore.clearAnchorOrThrow.
      if (store.read() !== null) throw new Error('OS credential store refused to clear the app-lock anchor');
    },
    // Same store selection: the record + anchor this writes are exactly what
    // the relaunched lock controller will read for the activated library
    // (#754). recover() reuses the pending-file two-phase commit, so a crash
    // mid-write reconciles instead of bricking.
    reestablishLock: async ({ libraryId, password, masterKey }) => {
      const store = new AppLockCredentialStore({
        dataDir: options.targetDir,
        anchorStore: lockAnchorStore(options),
        safeStorage: options.safeStorage(),
      });
      await store.recover({ libraryId, password, masterKey });
    },
    workStarted: () => options.workChanged(1),
    workFinished: () => options.workChanged(-1),
    activated: () => {
      // Do not quit. Recovery stays on the complete screen so the user can
      // see what restored. Opening the new catalog is a restart they choose.
    },
  });
}
