import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ApplicableTheme } from '../../src/shared/ipc/theme-channels.js';
import { installPersistedThemeObserver, type UserThemeSettingsClient } from '../../src/renderer/src/theme/persisted-theme.js';
import { UserThemeLayer, type ConstructedSheet, type UserThemeLayerHost } from '../../src/renderer/src/theme/user-theme-layer.js';
import type { AppSettings } from '../../src/shared/settings/settings.js';

class FakeHost implements UserThemeLayerHost {
  readonly root = { dataset: {} as { theme?: string }, style: { colorScheme: '' } };
  sheets: ConstructedSheet[] = [];
  createSheet(): ConstructedSheet {
    return { replaceSync: () => undefined };
  }
  adoptedSheets(): readonly ConstructedSheet[] {
    return this.sheets;
  }
  adopt(sheets: readonly ConstructedSheet[]): void {
    this.sheets = [...sheets];
  }
}

class FakeSettings implements UserThemeSettingsClient {
  private resolveGet!: (value: { settings: Pick<AppSettings, 'userTheme'> }) => void;
  private readonly listeners = new Set<(payload: { settings: Pick<AppSettings, 'userTheme'> }) => void>();
  readonly pending = new Promise<{ settings: Pick<AppSettings, 'userTheme'> }>((resolve) => (this.resolveGet = resolve));
  get(): Promise<{ settings: Pick<AppSettings, 'userTheme'> }> {
    return this.pending;
  }
  onChanged(listener: (payload: { settings: Pick<AppSettings, 'userTheme'> }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  push(userTheme: string | null): void {
    for (const listener of this.listeners) listener({ settings: { userTheme } });
  }
  resolve(userTheme: string | null): void {
    this.resolveGet({ settings: { userTheme } });
  }
}

const theme: ApplicableTheme = {
  id: 'night-0123456789ab',
  meta: { name: 'Night', version: '1.0.0', base: 'dark', tokensVersion: 1 },
  tokens: { '--accent-iris': 'rgb(50% 40% 90%)' },
  warnings: [],
};

test('persisted-theme observer follows pushes and ignores a stale initial settings read (#396)', async () => {
  const layer = new UserThemeLayer(new FakeHost());
  const settings = new FakeSettings();
  const dispose = installPersistedThemeObserver({
    layer,
    settings,
    themes: { active: () => Promise.resolve({ theme, notice: null }) },
  });
  settings.push(theme.id);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(layer.activeId(), theme.id);

  settings.resolve(null);
  await settings.pending;
  await Promise.resolve();
  assert.equal(layer.activeId(), theme.id);
  dispose();
});

test('invalid persisted themes clear the layer and retain a visible notice', async () => {
  const layer = new UserThemeLayer(new FakeHost());
  const settings = new FakeSettings();
  const dispose = installPersistedThemeObserver({
    layer,
    settings,
    themes: { active: () => Promise.resolve({ theme: null, notice: 'invalid' }) },
  });
  settings.resolve(theme.id);
  await settings.pending;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(layer.activeId(), null);
  assert.equal(layer.notice(), 'invalid');
  dispose();
});
