import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import {
  createAppearanceRuntime,
  HIGH_CONTRAST_WINDOW_BACKGROUND,
  withAppearanceBootstrapQuery,
  WINDOW_BACKGROUND,
  type AppearanceSettingsSource,
  type NativeThemeSource,
} from '../../src/main/appearance-runtime.js';
import type { AppSettings } from '../../src/shared/settings/settings.js';

type Appearance = AppSettings['appearance'];

test('appearance bootstrap URL replaces a stale theme without losing its surface query (#395 review)', () => {
  assert.equal(
    withAppearanceBootstrapQuery('file:///app/index.html?surface=inspector&theme=dark', 'light'),
    'file:///app/index.html?surface=inspector&theme=light',
  );
});

class FakeSettings implements AppearanceSettingsSource {
  private appearance: Appearance = 'dark';
  private readonly listeners = new Set<(settings: Pick<AppSettings, 'appearance'>) => void>();

  get(): Pick<AppSettings, 'appearance'> {
    return { appearance: this.appearance };
  }

  subscribe(listener: (settings: Pick<AppSettings, 'appearance'>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(appearance: Appearance): void {
    this.appearance = appearance;
    for (const listener of this.listeners) listener(this.get());
  }
}

class FakeNativeTheme extends EventEmitter implements NativeThemeSource {
  private source: Appearance = 'system';
  systemDark = false;
  systemHighContrast = false;

  get themeSource(): Appearance {
    return this.source;
  }

  set themeSource(value: Appearance) {
    this.source = value;
  }

  get shouldUseDarkColors(): boolean {
    return this.source === 'dark' || (this.source === 'system' && this.systemDark);
  }

  get shouldUseHighContrastColors(): boolean {
    return this.systemHighContrast;
  }

  override on(event: 'updated', listener: () => void): this {
    return super.on(event, listener);
  }

  override off(event: 'updated', listener: () => void): this {
    return super.off(event, listener);
  }
}

test('appearance runtime synchronizes persisted, system, and native window themes before window creation (#395)', () => {
  const settings = new FakeSettings();
  const nativeTheme = new FakeNativeTheme();
  const applied: Array<{ appearance: string; backgroundColor: string }> = [];
  const runtime = createAppearanceRuntime({
    settings,
    nativeTheme,
    apply: (appearance, backgroundColor) => applied.push({ appearance, backgroundColor }),
  });

  assert.equal(nativeTheme.themeSource, 'dark');
  assert.deepEqual(applied.at(-1), { appearance: 'dark', backgroundColor: WINDOW_BACKGROUND.dark });

  settings.set('light');
  assert.equal(nativeTheme.themeSource, 'light');
  assert.deepEqual(applied.at(-1), { appearance: 'light', backgroundColor: WINDOW_BACKGROUND.light });

  nativeTheme.systemDark = true;
  settings.set('system');
  assert.deepEqual(applied.at(-1), { appearance: 'dark', backgroundColor: WINDOW_BACKGROUND.dark });
  nativeTheme.systemDark = false;
  nativeTheme.emit('updated');
  assert.deepEqual(applied.at(-1), { appearance: 'light', backgroundColor: WINDOW_BACKGROUND.light });

  nativeTheme.systemHighContrast = true;
  nativeTheme.emit('updated');
  assert.deepEqual(applied.at(-1), { appearance: 'light', backgroundColor: HIGH_CONTRAST_WINDOW_BACKGROUND.light });
  nativeTheme.systemDark = true;
  nativeTheme.emit('updated');
  assert.deepEqual(applied.at(-1), { appearance: 'dark', backgroundColor: HIGH_CONTRAST_WINDOW_BACKGROUND.dark });

  const count = applied.length;
  runtime.dispose();
  settings.set('dark');
  nativeTheme.emit('updated');
  assert.equal(applied.length, count);
});
