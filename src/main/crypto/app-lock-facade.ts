import type { AppLockControllerLike } from './app-lock-host.js';
import { recoverAppLock } from './app-lock-recovery.js';

export interface AppLockFacadeOptions {
  readonly controller: AppLockControllerLike;
  readonly currentMaster: () => Buffer;
  readonly libraryId: () => string;
  readonly dataDir: () => string;
  readonly pickRecovery: () => Promise<string | null>;
  readonly recoveryExportReceipt?: ((consume: boolean) => boolean) | undefined;
}

export function createAppLockFacade(options: AppLockFacadeOptions) {
  return {
    snapshot: () => options.controller.snapshot(),
    retryAfterMs: () => options.controller.retryAfterMs(),
    attemptsRemaining: () => options.controller.attemptsRemaining?.() ?? 3,
    unlock: (password: string) => options.controller.unlock(password),
    touchIdStatus: () => options.controller.touchIdStatus(),
    touchIdUnlock: () => options.controller.unlockWithTouchId(),
    touchIdEnable: (password: string) => options.controller.enableTouchId(password),
    touchIdDisable: () => options.controller.disableTouchId(),
    configure: async (password: string) => {
      const masterKey = options.currentMaster();
      try {
        await options.controller.configure({ libraryId: options.libraryId(), password, masterKey });
      } finally {
        masterKey.fill(0);
      }
    },
    lock: () => options.controller.lock(),
    changePassword: (currentPassword: string, nextPassword: string) => options.controller.changePassword(currentPassword, nextPassword),
    anchorPolicy: () => options.controller.anchorPolicy?.() ?? 'usability',
    setAnchorPolicy: async (password: string, policy: 'usability' | 'hardened', confirmedExport: boolean) => {
      if (policy === 'hardened' && (!confirmedExport || options.recoveryExportReceipt?.(false) !== true)) {
        return { ok: false as const, reason: null };
      }
      const result = await (options.controller.setAnchorPolicy?.(password, policy) ??
        Promise.resolve({ ok: false as const, reason: null }));
      if (result.ok && policy === 'hardened') options.recoveryExportReceipt?.(true);
      return result;
    },
    remove: (password: string) => options.controller.remove(password),
    pickRecovery: options.pickRecovery,
    recover: (path: string, recoveryPassword: string, nextPassword: string) =>
      recoverAppLock({
        controller: options.controller,
        dataDir: options.dataDir(),
        libraryId: options.libraryId(),
        path,
        recoveryPassword,
        nextPassword,
      }),
  };
}
