import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { ApplicableTheme } from '../../src/shared/ipc/theme-channels.js';
import { UserThemeLayer, themeCss, type ConstructedSheet, type UserThemeLayerHost } from '../../src/renderer/src/theme/user-theme-layer.js';

class FakeSheet implements ConstructedSheet {
  css = '';
  replaceSync(css: string): void {
    this.css = css;
  }
}

class FakeHost implements UserThemeLayerHost {
  readonly root = { dataset: {} as { theme?: string }, style: { colorScheme: '' } };
  sheets: ConstructedSheet[] = [];

  createSheet(): ConstructedSheet {
    return new FakeSheet();
  }

  adoptedSheets(): readonly ConstructedSheet[] {
    return this.sheets;
  }

  adopt(sheets: readonly ConstructedSheet[]): void {
    this.sheets = [...sheets];
  }
}

const theme = (id: string, base: 'dark' | 'light', color: string): ApplicableTheme => ({
  id,
  meta: { name: id, version: '1.0.0', base, tokensVersion: 1 },
  tokens: { '--accent-iris': color },
  warnings: [],
});

test('user-theme CSS is allowlisted and disabled under OS accessibility layers (#396)', () => {
  const css = themeCss({
    ...theme('valid', 'dark', 'rgb(10% 20% 30%)'),
    tokens: { '--accent-iris': 'rgb(10% 20% 30%)', '--not-a-token': 'rgb(0% 0% 0%)' },
  });
  assert.equal(css, "@media (forced-colors: none){:root:not([data-contrast='more']){--accent-iris:rgb(10% 20% 30%)}}");
  assert.doesNotMatch(css, /not-a-token/);
});

test('user-theme support does not widen the renderer CSP (#396)', () => {
  const html = readFileSync('src/renderer/index.html', 'utf8');
  const policy = /Content-Security-Policy"\s+content="([^"]+)"/u.exec(html)?.[1];
  assert.ok(policy);
  assert.match(policy, /default-src 'self'/u);
  assert.match(policy, /style-src 'self' 'unsafe-inline'/u);
  assert.doesNotMatch(policy, /https?:|style-src \*/u);
});

test('preview and revert replace one last adopted sheet atomically (#396)', () => {
  const host = new FakeHost();
  const firstParty = new FakeSheet();
  host.sheets = [firstParty];
  const layer = new UserThemeLayer(host);
  let changes = 0;
  layer.subscribe(() => changes++);

  layer.setPersisted(theme('dark-theme', 'dark', 'rgb(10% 20% 30%)'));
  const persistedSheet = host.sheets[1] as FakeSheet;
  assert.equal(host.sheets[0], firstParty);
  assert.match(persistedSheet.css, /--accent-iris:rgb\(10% 20% 30%\)/);
  assert.equal(host.root.dataset.theme, 'dark');

  layer.preview(theme('light-preview', 'light', 'rgb(30% 40% 50%)'));
  assert.equal(host.sheets.length, 2);
  assert.notEqual(host.sheets[1], persistedSheet);
  assert.equal(layer.activeId(), 'light-preview');
  assert.equal(layer.base(), 'light');
  assert.equal(host.root.style.colorScheme, 'light');

  layer.cancelPreview();
  assert.equal(layer.activeId(), 'dark-theme');
  assert.equal(host.sheets.length, 2);
  layer.reset();
  assert.deepEqual(host.sheets, [firstParty]);
  assert.equal(layer.activeId(), null);
  assert.equal(changes, 4);
});
