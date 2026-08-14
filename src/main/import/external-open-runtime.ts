import { app, BrowserWindow } from 'electron';

import { events } from '../../shared/ipc/channels.js';
import { createEmitter } from '../../shared/ipc/registry.js';
import { createWindow } from '../app-window.js';
import { requestNativeWindowAttention } from '../e2e-window-visibility.js';
import { commandLineOpenPaths, ExternalOpenIntake, openPathKey } from './external-open-intake.js';
import { isLibraryDocumentPath } from '../../shared/library/library-document.js';

const MAX_PENDING_LIBRARY_DOCUMENTS = 100_000;

export interface ExternalOpenRuntime {
  readonly whenReady: () => Promise<void>;
  readonly rendererReady: () => void;
  readonly followAuthorization: (source: ExternalOpenAuthorizationSource) => void;
  readonly handleLibraryDocuments: (handler: (path: string) => Promise<void>) => Promise<void>;
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
    handleLibraryDocuments: () => Promise.resolve(),
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
  let documentHandler: ((path: string) => Promise<void>) | undefined;
  const pendingDocuments = new Map<string, string>();
  let documentDrain = Promise.resolve();
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
  const flushDocuments = (): Promise<void> => {
    const handler = documentHandler;
    if (handler === undefined || pendingDocuments.size === 0) return documentDrain;
    const paths = [...pendingDocuments.values()];
    pendingDocuments.clear();
    documentDrain = documentDrain
      .catch(() => undefined)
      .then(async () => {
        for (const path of paths) await handler(path);
      });
    void documentDrain.catch(() => undefined);
    return documentDrain;
  };
  const enqueue = (paths: readonly string[], cwd = process.cwd()): void => {
    const imports: string[] = [];
    for (const path of commandLineOpenPaths(['Overlook', ...paths], true, cwd)) {
      if (isLibraryDocumentPath(path)) {
        if (pendingDocuments.size < MAX_PENDING_LIBRARY_DOCUMENTS) {
          pendingDocuments.set(openPathKey(path), path);
        }
      } else imports.push(path);
    }
    intake.enqueue(imports, cwd);
    if (pendingDocuments.size > 0) {
      if (runtimeReady) focusPrimaryWindow();
      void flushDocuments();
    }
  };

  if (primaryInstance) {
    enqueue(initialOpenPaths);
    app.on('open-file', (event, filePath) => {
      event.preventDefault();
      enqueue([filePath]);
    });
    app.on('second-instance', (_event, argv, workingDirectory) => {
      enqueue(commandLineOpenPaths(argv, app.isPackaged, workingDirectory), workingDirectory);
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
    handleLibraryDocuments: (handler) => {
      documentHandler = handler;
      return flushDocuments();
    },
    finishBootstrap: () => {
      runtimeReady = true;
      openPrimaryWindow();
      app.on('activate', focusPrimaryWindow);
    },
    close: () => {
      documentHandler = undefined;
      pendingDocuments.clear();
      intake.close();
    },
  };
}
