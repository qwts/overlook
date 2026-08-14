import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  installAppearanceObserver,
  resolveAppearance,
  type AppearanceMediaQuery,
  type AppearanceRoot,
  type AppearanceSettingsClient,
} from '../../src/renderer/src/theme/appearance.js';
import type { AppSettings } from '../../src/shared/settings/settings.js';

type Appearance = AppSettings['appearance'];

class FakeMedia implements AppearanceMediaQuery {
  matches = false;
  private readonly listeners = new Set<() => void>();

  addEventListener(_event: 'change', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_event: 'change', listener: () => void): void {
    this.listeners.delete(listener);
  }

  set(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.listeners) listener();
  }
}

class FakeSettings implements AppearanceSettingsClient {
  private resolveGet!: (value: { settings: Pick<AppSettings, 'appearance'> }) => void;
  private readonly listeners = new Set<(payload: { settings: Pick<AppSettings, 'appearance'> }) => void>();
  readonly pendingGet = new Promise<{ settings: Pick<AppSettings, 'appearance'> }>((resolve) => {
    this.resolveGet = resolve;
  });

  get(): Promise<{ settings: Pick<AppSettings, 'appearance'> }> {
    return this.pendingGet;
  }

  onChanged(listener: (payload: { settings: Pick<AppSettings, 'appearance'> }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  push(appearance: Appearance): void {
    for (const listener of this.listeners) listener({ settings: { appearance } });
  }

  resolve(appearance: Appearance): void {
    this.resolveGet({ settings: { appearance } });
  }
}

test('appearance resolution follows the system only in system mode (#395)', () => {
  assert.equal(resolveAppearance('dark', false), 'dark');
  assert.equal(resolveAppearance('light', true), 'light');
  assert.equal(resolveAppearance('system', false), 'light');
  assert.equal(resolveAppearance('system', true), 'dark');
});

test('renderer appearance observer applies live settings and ignores a stale initial response (#395)', async () => {
  const root: AppearanceRoot = { dataset: {}, style: { colorScheme: '' } };
  const media = new FakeMedia();
  const contrastMedia = new FakeMedia();
  const settings = new FakeSettings();
  const dispose = installAppearanceObserver({ root, media, contrastMedia, settings });

  assert.equal(root.dataset.theme, 'light');
  assert.equal(root.dataset.contrast, undefined);
  assert.equal(root.style.colorScheme, 'light');
  settings.push('dark');
  assert.equal(root.dataset.theme, 'dark');
  media.set(true);
  assert.equal(root.dataset.theme, 'dark');

  settings.push('system');
  assert.equal(root.dataset.theme, 'dark');
  media.set(false);
  assert.equal(root.dataset.theme, 'light');

  contrastMedia.set(true);
  assert.equal(root.dataset.contrast, 'more');
  contrastMedia.set(false);
  assert.equal(root.dataset.contrast, undefined);

  settings.resolve('dark');
  await settings.pendingGet;
  assert.equal(root.dataset.theme, 'light');

  dispose();
  settings.push('dark');
  media.set(true);
  contrastMedia.set(true);
  assert.equal(root.dataset.theme, 'light');
  assert.equal(root.dataset.contrast, undefined);
});
