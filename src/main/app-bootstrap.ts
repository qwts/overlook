import { app, BrowserWindow } from 'electron';

import { requestNativeWindowAttention } from './e2e-window-visibility.js';

// Profile-level single instance (ADR-0017 §5, #385): Electron scopes the
// lock to userData, so isolated E2E harness profiles still run concurrently.
// A second instance on the same profile hands off and exits; the first
// instance surfaces its window.
export function registerSingleInstance(): void {
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
  }
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win !== undefined) {
      requestNativeWindowAttention(win, {
        packaged: app.isPackaged,
        harness: process.env['OVERLOOK_E2E'],
        mode: process.env['OVERLOOK_E2E_WINDOW'],
      });
    }
  });
}

export interface QuitTeardownOptions {
  readonly isLibraryOpen: () => boolean;
  /** 'unlocked' means the app-lock lifecycle owns the quit (its lock() runs
   * the same close path); anything else is ours. */
  readonly lockState: () => string | undefined;
  readonly close: () => Promise<void>;
  readonly shutdown?: () => Promise<void>;
}

// Universal quit teardown (ADR-0017 §4, #385): every open-library quit — most
// importantly the unconfigured-lock default — runs the full teardown, so WAL
// checkpoints and the library lock releases on ordinary exits too.
export function registerQuitTeardown(options: QuitTeardownOptions): void {
  let done = false;
  app.on('before-quit', (event) => {
    if (done) return;
    const libraryOpen = options.isLibraryOpen();
    if (libraryOpen && options.lockState() === 'unlocked') return;
    event.preventDefault();
    done = true;
    const closeLibrary = libraryOpen ? options.close() : Promise.resolve();
    void Promise.allSettled([closeLibrary, options.shutdown?.() ?? Promise.resolve()]).finally(() => app.quit());
  });
}
