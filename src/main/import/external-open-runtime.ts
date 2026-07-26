import { app, BrowserWindow } from 'electron';

import { events } from '../../shared/ipc/channels.js';
import { createEmitter } from '../../shared/ipc/registry.js';
import { createWindow } from '../app-window.js';
import { requestNativeWindowAttention } from '../e2e-window-visibility.js';
import { commandLineOpenPaths, ExternalOpenIntake } from './external-open-intake.js';

export interface ExternalOpenRuntime {
  readonly whenReady: () => Promise<void>;
  readonly rendererReady: () => void;
  readonly followAuthorization: (source: ExternalOpenAuthorizationSource) => void;
  readonly finishBootstrap: () => void;
  readonly close: () => void;
}

export interface ExternalOpenAuthorizationSource {
  readonly snapshot: () => { readonly state: string };
  readonly subscribe: (listener: (state: { readonly state: string }) => void) => unknown;
}

export interface ExternalOpenRuntimeOptions {
  /** Unpackaged harness profiles are already isolated by userData and must be
   * allowed to run concurrently across Playwright workers. */
  readonly isolatedHarnessProfile?: boolean;
}

/** Native messaging runs inside the signed app executable without renderer,
 * document-intake, or single-instance side effects. */
export function createHeadlessExternalOpenRuntime(): ExternalOpenRuntime {
  return {
    whenReady: () => app.whenReady(),
    rendererReady: () => undefined,
    followAuthorization: () => undefined,
    finishBootstrap: () => undefined,
    close: () => undefined,
  };
}

/** Installs pre-ready OS document handlers before Electron can dispatch macOS
 * open-file events. Every path then enters one coalesced renderer queue. */
export function createExternalOpenRuntime(options: ExternalOpenRuntimeOptions = {}): ExternalOpenRuntime {
  const initialOpenPaths = commandLineOpenPaths(process.argv, app.isPackaged, process.cwd());
  const primaryInstance = options.isolatedHarnessProfile === true || app.requestSingleInstanceLock();
  if (!primaryInstance) app.quit();

  const emit = createEmitter(events.importExternalPaths, (name, payload) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(name, payload);
  });
  let runtimeReady = false;
  const intake = new ExternalOpenIntake({
    deliver: (paths) => emit({ paths: [...paths] }),
    // BrowserWindow APIs are unavailable during macOS open-file cold start.
    attention: () => {
      if (runtimeReady) focusPrimaryWindow();
    },
  });

  const openPrimaryWindow = (): BrowserWindow => {
    intake.rendererUnavailable();
    const win = createWindow();
    win.on('closed', () => intake.rendererUnavailable());
    return win;
  };
  const focusPrimaryWindow = (): void => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win === undefined) {
      if (runtimeReady) openPrimaryWindow();
      return;
    }
    requestNativeWindowAttention(win, {
      packaged: app.isPackaged,
      harness: process.env['OVERLOOK_E2E'],
      mode: process.env['OVERLOOK_E2E_WINDOW'],
    });
  };

  if (primaryInstance) {
    intake.enqueue(initialOpenPaths);
    app.on('open-file', (event, filePath) => {
      event.preventDefault();
      intake.enqueue([filePath]);
    });
    app.on('second-instance', (_event, argv, workingDirectory) => {
      intake.enqueue(commandLineOpenPaths(argv, app.isPackaged, workingDirectory), workingDirectory);
    });
  }

  return {
    whenReady: () => (primaryInstance ? app.whenReady() : new Promise<void>(() => undefined)),
    rendererReady: () => intake.rendererReady(),
    followAuthorization: (source) => {
      const update = ({ state }: { readonly state: string }): void => {
        intake.setAuthorized(state === 'unconfigured-unlocked' || state === 'unlocked');
      };
      update(source.snapshot());
      source.subscribe(update);
    },
    finishBootstrap: () => {
      runtimeReady = true;
      openPrimaryWindow();
      app.on('activate', focusPrimaryWindow);
    },
    close: () => intake.close(),
  };
}
