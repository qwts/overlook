import { app } from 'electron';
import path from 'node:path';

import { ScopedSettingsStore } from './scoped-settings-store.js';
import { installAppearanceHost } from '../appearance-host.js';

let settingsStore: ScopedSettingsStore | undefined;
let libraryDataDir = (): string => path.join(app.getPath('userData'), 'library');
let appearanceHostInstalled = false;

function removeUnavailableMockSelection(store: ScopedSettingsStore): void {
  const mockAvailable = !app.isPackaged && process.env['OVERLOOK_E2E'] !== undefined;
  if (!mockAvailable && store.get().providerId === 'mock') store.set({ providerId: null });
}

export function configureSettingsLibrary(dataDir: () => string): () => string {
  libraryDataDir = dataDir;
  if (settingsStore !== undefined) activateSettingsLibrary();
  if (!appearanceHostInstalled) {
    installAppearanceHost(getSettingsStore());
    appearanceHostInstalled = true;
  }
  return dataDir;
}

export function getSettingsStore(): ScopedSettingsStore {
  if (settingsStore === undefined) {
    settingsStore = new ScopedSettingsStore({
      profileFilePath: path.join(app.getPath('userData'), 'settings.json'),
      libraryFilePath: () => path.join(libraryDataDir(), 'settings.json'),
    });
    removeUnavailableMockSelection(settingsStore);
  }
  return settingsStore;
}

export function activateSettingsLibrary(): void {
  const store = getSettingsStore();
  store.activateLibrary();
  // The mock adapter exists only in E2E. Apply the correction for every newly
  // active library, not just the startup library.
  removeUnavailableMockSelection(store);
}
