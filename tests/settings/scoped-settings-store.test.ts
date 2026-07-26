import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScopedSettingsStore } from '../../src/main/settings/scoped-settings-store.js';
import { defaultSettings } from '../../src/shared/settings/settings.js';

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'overlook-scoped-settings-'));
  const profileFilePath = join(root, 'settings.json');
  let library = join(root, 'library-a');
  mkdirSync(library);
  const store = new ScopedSettingsStore({ profileFilePath, libraryFilePath: () => join(library, 'settings.json') });
  return {
    root,
    profileFilePath,
    store,
    switchTo(name: string) {
      library = join(root, name);
      mkdirSync(library, { recursive: true });
      store.activateLibrary();
    },
    librarySettings(name: string): unknown {
      return JSON.parse(readFileSync(join(root, name, 'settings.json'), 'utf8'));
    },
  };
}

describe('scoped settings store (#387, ADR-0017 §6)', () => {
  test('library settings and provider selection do not bleed across switches', () => {
    const h = harness();
    h.store.set({ sortOrder: 'name', providerId: 'pcloud', appLockIdle: '30', reOffloadAfterViewing: false, trashRetention: '90' });

    h.switchTo('library-b');
    assert.equal(h.store.get().sortOrder, defaultSettings.sortOrder);
    assert.equal(h.store.get().providerId, defaultSettings.providerId);
    assert.equal(h.store.get().appLockIdle, defaultSettings.appLockIdle);
    assert.equal(h.store.get().reOffloadAfterViewing, defaultSettings.reOffloadAfterViewing);
    assert.equal(h.store.get().trashRetention, defaultSettings.trashRetention);
    h.store.set({ sortOrder: 'size', providerId: null, trashRetention: 'off' });

    h.switchTo('library-a');
    assert.equal(h.store.get().sortOrder, 'name');
    assert.equal(h.store.get().providerId, 'pcloud');
    assert.equal(h.store.get().appLockIdle, '30');
    assert.equal(h.store.get().reOffloadAfterViewing, false);
    assert.equal(h.store.get().trashRetention, '90');
    assert.deepEqual(h.librarySettings('library-b'), {
      sortOrder: 'size',
      thumbnailsOnImport: true,
      autoBackupOnImport: true,
      reOffloadAfterViewing: true,
      importMode: 'copy',
      wifiOnly: true,
      bandwidthLimit: 100,
      trashRetention: 'off',
      appLockIdle: '5',
      lockWhenHidden: false,
      providerId: null,
    });
  });

  test('profile settings follow the user while library settings remain isolated', () => {
    const h = harness();
    h.store.set({
      appearance: 'light',
      language: 'en-XB',
      quickActions: ['photo.export', 'photo.favorite.toggle'],
      shareDiagnostics: true,
      sortOrder: 'name',
    });
    h.switchTo('library-b');

    assert.equal(h.store.get().appearance, 'light');
    assert.equal(h.store.get().language, 'en-XB');
    assert.equal(h.store.get().shareDiagnostics, true);
    assert.deepEqual(h.store.get().quickActions, ['photo.export', 'photo.favorite.toggle']);
    assert.equal(h.store.get().diagnosticsConsentVersion, 1);
    assert.equal(h.store.get().sortOrder, 'date');
  });

  test('a failed library write leaves memory and restart on the last durable provider selection (#488 review)', () => {
    const root = mkdtempSync(join(tmpdir(), 'overlook-scoped-settings-failure-'));
    const profileFilePath = join(root, 'settings.json');
    const libraryFilePath = join(root, 'library', 'settings.json');
    mkdirSync(join(root, 'library'));
    let failLibraryWrite = false;
    const persist = (filePath: string, value: unknown): void => {
      if (failLibraryWrite && filePath === libraryFilePath) throw new Error('injected settings write failure');
      writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    };
    const store = new ScopedSettingsStore({ profileFilePath, libraryFilePath: () => libraryFilePath, persist });
    store.set({ providerId: 'pcloud' });

    failLibraryWrite = true;
    assert.throws(() => store.set({ providerId: null }), /injected settings write failure/u);
    assert.equal(store.get().providerId, 'pcloud', 'failed persistence cannot publish optimistic state in memory');

    const restarted = new ScopedSettingsStore({ profileFilePath, libraryFilePath: () => libraryFilePath });
    assert.equal(restarted.get().providerId, 'pcloud', 'restart reads the same last durable provider selection');
  });

  test('legacy combined settings migrate once into the active library', () => {
    const root = mkdtempSync(join(tmpdir(), 'overlook-scoped-settings-migration-'));
    const profileFilePath = join(root, 'settings.json');
    writeFileSync(
      profileFilePath,
      JSON.stringify({ ...defaultSettings, appearance: 'light', sortOrder: 'size', providerId: 'pcloud' }),
      'utf8',
    );
    let library = join(root, 'legacy-library');
    mkdirSync(library);
    const store = new ScopedSettingsStore({ profileFilePath, libraryFilePath: () => join(library, 'settings.json') });

    assert.equal(store.get().appearance, 'light');
    assert.equal(store.get().sortOrder, 'size');
    assert.equal(store.get().providerId, 'pcloud');
    assert.deepEqual(JSON.parse(readFileSync(profileFilePath, 'utf8')), {
      appearance: 'light',
      language: null,
      quickActions: defaultSettings.quickActions,
      shareDiagnostics: false,
      diagnosticsConsentVersion: 0,
      llmProviderId: null,
      llmQaEnabled: false,
      semanticSearchEnabled: false,
    });

    library = join(root, 'new-library');
    store.activateLibrary();
    assert.equal(store.get().sortOrder, defaultSettings.sortOrder, 'legacy library preferences migrate only once');
    assert.equal(store.get().providerId, defaultSettings.providerId);
  });

  test('legacy migration does not materialize a fresh virtual restore target', () => {
    const root = mkdtempSync(join(tmpdir(), 'overlook-scoped-settings-virtual-'));
    const profileFilePath = join(root, 'settings.json');
    const virtualLibrary = join(root, 'library');
    writeFileSync(profileFilePath, JSON.stringify({ ...defaultSettings, sortOrder: 'name' }), 'utf8');

    const store = new ScopedSettingsStore({
      profileFilePath,
      libraryFilePath: () => join(virtualLibrary, 'settings.json'),
    });
    assert.equal(store.get().sortOrder, 'name', 'legacy value remains available in memory');
    assert.equal(existsSync(virtualLibrary), false, 'cloud restore still sees an absent/empty target');

    mkdirSync(virtualLibrary);
    store.activateLibrary();
    assert.equal(existsSync(join(virtualLibrary, 'settings.json')), true, 'the move commits after registry materialization');
  });

  test('an existing library settings file wins over a leftover legacy profile seed', () => {
    const root = mkdtempSync(join(tmpdir(), 'overlook-scoped-settings-existing-'));
    const profileFilePath = join(root, 'settings.json');
    const existingLibrary = join(root, 'existing-library');
    mkdirSync(existingLibrary);
    writeFileSync(profileFilePath, JSON.stringify({ ...defaultSettings, sortOrder: 'name', providerId: 'pcloud' }), 'utf8');
    writeFileSync(
      join(existingLibrary, 'settings.json'),
      JSON.stringify({
        sortOrder: 'size',
        thumbnailsOnImport: true,
        autoBackupOnImport: true,
        reOffloadAfterViewing: true,
        importMode: 'copy',
        wifiOnly: true,
        bandwidthLimit: 100,
        trashRetention: '30',
        appLockIdle: '5',
        lockWhenHidden: false,
        providerId: null,
      }),
      'utf8',
    );
    let library = existingLibrary;
    const store = new ScopedSettingsStore({ profileFilePath, libraryFilePath: () => join(library, 'settings.json') });
    assert.equal(store.get().sortOrder, 'size');
    assert.equal(store.get().providerId, null);

    library = join(root, 'new-library');
    mkdirSync(library);
    store.activateLibrary();
    assert.equal(store.get().sortOrder, defaultSettings.sortOrder, 'the stale legacy seed cannot leak into another library');
  });
});
