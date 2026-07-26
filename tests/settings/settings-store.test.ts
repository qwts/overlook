import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScopedSettingsStore } from '../../src/main/settings/scoped-settings-store.js';
import { channels } from '../../src/shared/ipc/channels.js';
import { wrapHandler } from '../../src/shared/ipc/registry.js';
import { defaultSettings, throttlePercentOf } from '../../src/shared/settings/settings.js';

// #111: one typed settings truth — defaults per the design, atomic JSON
// persistence, per-key corrupt recovery, change events. The IPC boundary
// (settings:set) is exercised through the real channel schema, so the
// locked key and range rules are proven where they actually enforce.

function profilePath(dir: string): string {
  return join(dir, 'settings.json');
}

function libraryPath(dir: string): string {
  return join(dir, 'library', 'settings.json');
}

function storeIn(dir: string): ScopedSettingsStore {
  mkdirSync(join(dir, 'library'), { recursive: true });
  return new ScopedSettingsStore({ profileFilePath: profilePath(dir), libraryFilePath: () => libraryPath(dir) });
}

describe('settings store (#111)', () => {
  test('a fresh profile gets the design defaults', () => {
    const store = storeIn(mkdtempSync(join(tmpdir(), 'overlook-settings-')));
    assert.deepEqual(store.get(), defaultSettings);
    assert.equal(store.get().sortOrder, 'date');
    assert.equal(store.get().autoBackupOnImport, true);
    assert.equal(store.get().reOffloadAfterViewing, true);
    assert.equal(store.get().wifiOnly, true);
  });

  test('EXIT CRITERIA: settings persist across a restart (new store, same file)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-settings-'));
    storeIn(dir).set({
      sortOrder: 'name',
      bandwidthLimit: 40,
      providerId: null,
      reOffloadAfterViewing: false,
      quickActions: ['photo.export', 'photo.favorite.toggle'],
      shareDiagnostics: true,
      trashRetention: '90',
    });

    const reborn = storeIn(dir);
    assert.equal(reborn.get().sortOrder, 'name');
    assert.equal(reborn.get().bandwidthLimit, 40);
    assert.equal(reborn.get().providerId, null, 'disconnected survives — null is a value, not "unset"');
    assert.equal(reborn.get().reOffloadAfterViewing, false);
    assert.equal(reborn.get().shareDiagnostics, true);
    assert.equal(reborn.get().trashRetention, '90');
    assert.deepEqual(reborn.get().quickActions, ['photo.export', 'photo.favorite.toggle']);
    assert.equal(reborn.get().diagnosticsConsentVersion, 1);
    assert.equal(reborn.get().wifiOnly, true, 'untouched keys keep their defaults');
  });

  test('EXIT CRITERIA: an unparseable file recovers to defaults, then heals on the next write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-settings-'));
    mkdirSync(join(dir, 'library'), { recursive: true });
    writeFileSync(libraryPath(dir), '{ not json', 'utf8');

    const store = storeIn(dir);
    assert.deepEqual(store.get(), defaultSettings);
    store.set({ sortOrder: 'size' });
    assert.equal(storeIn(dir).get().sortOrder, 'size', 'the write replaced the corrupt file');
  });

  test('one bad key falls back alone — the rest of the file survives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-settings-'));
    writeFileSync(
      profilePath(dir),
      JSON.stringify({
        sortOrder: 'name',
        bandwidthLimit: 'fast',
        wifiOnly: false,
        thumbnailsOnImport: false,
        reOffloadAfterViewing: 'sometimes',
      }),
      'utf8',
    );

    const settings = storeIn(dir).get();
    assert.equal(settings.sortOrder, 'name', 'good key kept');
    assert.equal(settings.wifiOnly, false, 'good key kept');
    assert.equal(settings.bandwidthLimit, defaultSettings.bandwidthLimit, 'bad key → its default');
    assert.equal(settings.thumbnailsOnImport, true, 'locked key cannot be persisted off');
    assert.equal(settings.reOffloadAfterViewing, true, 'invalid custody policy recovers to its safe default');
  });

  test('writes are atomic: live file always parses, no staging file left behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-settings-'));
    const store = storeIn(dir);
    store.set({ appearance: 'light', sortOrder: 'name' });
    assert.deepEqual(JSON.parse(readFileSync(profilePath(dir), 'utf8')), {
      appearance: 'light',
      language: null,
      quickActions: defaultSettings.quickActions,
      shareDiagnostics: false,
      diagnosticsConsentVersion: 0,
      llmProviderId: null,
      llmQaEnabled: false,
      semanticSearchEnabled: false,
    });
    assert.equal((JSON.parse(readFileSync(libraryPath(dir), 'utf8')) as { sortOrder: string }).sortOrder, 'name');
    assert.equal(existsSync(`${profilePath(dir)}.tmp`), false);
    assert.equal(existsSync(`${libraryPath(dir)}.tmp`), false);
  });

  test('change events push the full snapshot; unsubscribe stops them', () => {
    const store = storeIn(mkdtempSync(join(tmpdir(), 'overlook-settings-')));
    const seen: string[] = [];
    const unsubscribe = store.subscribe((settings) => seen.push(settings.sortOrder));
    store.set({ sortOrder: 'name' });
    store.set({ sortOrder: 'size' });
    unsubscribe();
    store.set({ sortOrder: 'date' });
    assert.deepEqual(seen, ['name', 'size']);
  });

  test('IPC boundary: the locked key and slider range reject in the channel schema', async () => {
    const store = storeIn(mkdtempSync(join(tmpdir(), 'overlook-settings-')));
    const handler = wrapHandler(channels.settingsSet, ({ patch }) => ({ settings: store.set(patch) }));

    const invalid = { __overlookIpcFailure: true, error: { code: 'IPC_INVALID_REQUEST' } } as const;
    assert.deepEqual(await handler({ patch: { thumbnailsOnImport: false } }), invalid, 'locked true by design');
    assert.deepEqual(await handler({ patch: { bandwidthLimit: 5 } }), invalid, 'below the slider floor');
    assert.deepEqual(await handler({ patch: { bandwidthLimit: 101 } }), invalid, 'above unlimited');
    assert.deepEqual(await handler({ patch: { sortOrder: 'random' } }), invalid, 'unknown enum value');
    assert.deepEqual(await handler({ patch: { trashRetention: '14' } }), invalid, 'retention is the bounded ADR enum');
    assert.deepEqual(await handler({ patch: { providerId: '../cloud' } }), invalid, 'unsafe provider registry key');
    assert.deepEqual(await handler({ patch: { diagnosticsConsentVersion: 1 } }), invalid, 'renderer cannot forge consent policy');
    assert.deepEqual(await handler({ patch: { quickActions: ['photo.export', 'photo.export'] } }), invalid, 'Quick Action IDs are unique');
    assert.deepEqual(await handler({ patch: { quickActions: ['library.import'] } }), invalid, 'only eligible commands persist');

    const quickActions = ['photo.export', 'photo.favorite.toggle'] as const;
    const quickActionResult = await handler({ patch: { quickActions: [...quickActions] } });
    assert.ok('settings' in quickActionResult);
    assert.deepEqual(quickActionResult.settings.quickActions, quickActions);

    const ok = await handler({ patch: { bandwidthLimit: 10, wifiOnly: false, providerId: 'future-cloud' } });
    assert.ok('settings' in ok);
    assert.equal(ok.settings.bandwidthLimit, 10);
    assert.equal(store.get().wifiOnly, false);
    assert.equal(store.get().providerId, 'future-cloud', 'new adapters need no settings enum edit');
    for (const trashRetention of ['off', '7', '30', '90'] as const) {
      const result = await handler({ patch: { trashRetention } });
      assert.ok('settings' in result);
      assert.equal(result.settings.trashRetention, trashRetention);
    }
  });

  test('legacy local-only preference never upgrades silently into current diagnostics consent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlook-settings-'));
    writeFileSync(profilePath(dir), JSON.stringify({ ...defaultSettings, shareDiagnostics: true }), 'utf8');

    const store = storeIn(dir);
    assert.equal(store.get().shareDiagnostics, false);
    assert.equal(store.get().diagnosticsConsentVersion, 0);
    store.set({ shareDiagnostics: true });
    assert.equal(store.get().shareDiagnostics, true);
    assert.equal(store.get().diagnosticsConsentVersion, 1);
    store.set({ shareDiagnostics: false });
    assert.equal(store.get().diagnosticsConsentVersion, 0);
  });

  test('throttle mapping: 100 = unlimited (null), anything lower passes through', () => {
    assert.equal(throttlePercentOf({ ...defaultSettings, bandwidthLimit: 100 }), null);
    assert.equal(throttlePercentOf({ ...defaultSettings, bandwidthLimit: 40 }), 40);
  });
});
