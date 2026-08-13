import { app } from 'electron';

import { AppLockCredentialStore, type CredentialAnchorStore } from './app-lock-credentials.js';
import { AppLockController } from './app-lock-controller.js';
import { createAppLockFacade, type AppLockFacadeOptions } from './app-lock-facade.js';
import { OsCredentialAnchorStore } from './credential-anchor.js';
import type { SafeStorageLike } from './keystore.js';
import { UnlockThrottle } from './unlock-throttle.js';
import { events } from '../../shared/ipc/channels.js';
import { createEmitter } from '../../shared/ipc/registry.js';
import { registerAppLockHandlers } from '../ipc.js';
import { setContentAdmissionGate } from '../ipc.js';
import { registerAppLockLifecycle } from './app-lock-lifecycle.js';
import type { AppSettings } from '../../shared/settings/settings.js';
import { TouchIdService } from './touch-id.js';
import { createNativeTouchIdAdapter } from './touch-id-native.js';
import { TestTouchIdAdapter } from './test-touch-id-adapter.js';
import { registerInspectorWindowHandlers } from '../inspector-window-runtime.js';
import { LibraryLockError } from '../library/library-lock.js';

export interface AppLockRuntimeOptions {
  readonly dataDir: string;
  readonly safeStorage: SafeStorageLike;
  readonly openAuthorized: (masterKey?: Buffer) => void | Promise<void>;
  readonly closeAuthorized: () => void | Promise<void>;
  readonly failClosed: () => void;
  readonly anchorStore?: CredentialAnchorStore;
}

export function createAppLockRuntime(options: AppLockRuntimeOptions): AppLockController {
  const credentials = new AppLockCredentialStore({
    dataDir: options.dataDir,
    anchorStore: options.anchorStore ?? new OsCredentialAnchorStore({ dataDir: options.dataDir }),
    safeStorage: options.safeStorage,
  });
  const touchIdAdapter =
    !app.isPackaged && process.env['OVERLOOK_TOUCH_ID_FAKE'] === '1'
      ? new TestTouchIdAdapter()
      : createNativeTouchIdAdapter({ platform: process.platform, packaged: app.isPackaged });
  return new AppLockController({
    credentials,
    touchId: new TouchIdService(options.dataDir, touchIdAdapter, credentials),
    throttle: new UnlockThrottle({ dataDir: options.dataDir, safeStorage: options.safeStorage }),
    openAuthorized: options.openAuthorized,
    closeAuthorized: options.closeAuthorized,
    failClosed: options.failClosed,
    classifyOpenError: (error) => (error instanceof LibraryLockError ? 'library-in-use' : undefined),
  });
}

export interface AppLockIpcOptions extends AppLockFacadeOptions {
  readonly send: (name: string, payload: unknown) => void;
  readonly settings: () => Pick<AppSettings, 'appLockIdle' | 'lockWhenHidden'>;
}

export function registerAppLockIpc(options: AppLockIpcOptions): () => void {
  setContentAdmissionGate(() => options.controller.requireContentAccess());
  registerAppLockHandlers(() => createAppLockFacade(options));
  registerInspectorWindowHandlers(() => options.controller.requireContentAccess());
  const emit = createEmitter(events.appLockStateChanged, (name, payload) => options.send(name, payload));
  const emitTouchId = createEmitter(events.appLockTouchIdChanged, (name, payload) => options.send(name, payload));
  const offState = options.controller.subscribe((snapshot) => emit({ ...snapshot, retryAfterMs: options.controller.retryAfterMs() }));
  const offTouchId = options.controller.subscribeTouchId(emitTouchId);
  const offLifecycle = registerAppLockLifecycle({ controller: options.controller, settings: options.settings });
  return () => {
    offState();
    offTouchId();
    offLifecycle();
  };
}
