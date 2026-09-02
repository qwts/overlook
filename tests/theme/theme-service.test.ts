import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { ThemeService, THEME_PREVIEW_MS, type ThemeSettingsStore } from '../../src/main/theme/theme-service.js';
import { defaultSettings, mergeSettings, type AppSettings, type SettingsPatch } from '../../src/shared/settings/settings.js';
import { THEME_TOKENS } from '../../src/shared/theme/theme-file.js';

const themeFile = {
  meta: { name: 'Night Sky', author: 'Overlook', version: '1.2.3', base: 'dark', tokensVersion: 1 },
  tokens: { '--accent-iris': '#8877ff', '--surface-window': '#050508' },
};

class FakeSettings implements ThemeSettingsStore {
  value: AppSettings = { ...defaultSettings };

  get(): AppSettings {
    return this.value;
  }

  set(patch: SettingsPatch): AppSettings {
    this.value = mergeSettings(this.value, patch);
    return this.value;
  }
}

function world(now = 1_000): {
  readonly root: string;
  readonly themes: string;
  readonly source: string;
  readonly settings: FakeSettings;
  readonly service: ThemeService;
  readonly setNow: (value: number) => void;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'overlook-themes-'));
  const themes = path.join(root, 'profile', 'themes');
  const source = path.join(root, 'night-sky.overlook-theme.json');
  writeFileSync(source, JSON.stringify(themeFile), 'utf8');
  const settings = new FakeSettings();
  let clock = now;
  return { root, themes, source, settings, service: new ThemeService(themes, settings, () => clock), setNow: (value) => (clock = value) };
}

describe('profile theme service (#396)', () => {
  test('imports unmodified source bytes under a stable safe id and lists canonical swatches', async () => {
    const { source, themes, service } = world();
    const result = await service.importPath(source);
    assert.equal(result.status, 'imported');
    if (result.status !== 'imported') return;
    assert.match(result.theme.id, /^night-sky-[a-f0-9]{12}$/);
    assert.ok(result.theme.swatches.every((swatch) => swatch.startsWith('rgb(')));
    const files = await readdir(themes);
    assert.deepEqual(files, [`${result.theme.id}.overlook-theme.json`]);
    assert.equal(readFileSync(path.join(themes, files[0] ?? ''), 'utf8'), readFileSync(source, 'utf8'));
    assert.deepEqual(await service.list(), { themes: [result.theme], activeId: null });
    service.dispose();
  });

  test('rejects wrong extensions, oversized files, invalid JSON, and hostile colors without installing', async () => {
    const { root, themes, service } = world();
    const wrong = path.join(root, 'theme.json');
    writeFileSync(wrong, JSON.stringify(themeFile));
    assert.equal((await service.importPath(wrong)).status, 'invalid');

    const invalid = path.join(root, 'bad.overlook-theme.json');
    writeFileSync(invalid, '{not-json');
    const invalidResult = await service.importPath(invalid);
    assert.deepEqual(invalidResult, { status: 'invalid', errors: [{ path: '$', message: 'Theme file is not valid JSON' }] });

    const hostile = path.join(root, 'hostile.overlook-theme.json');
    writeFileSync(hostile, JSON.stringify({ ...themeFile, tokens: { '--surface-window': 'url(https://attacker.invalid/x)' } }));
    assert.equal((await service.importPath(hostile)).status, 'invalid');

    const large = path.join(root, 'large.overlook-theme.json');
    writeFileSync(large, Buffer.alloc(256 * 1024 + 1));
    assert.equal((await service.importPath(large)).status, 'invalid');
    await assert.rejects(() => readdir(themes), /ENOENT/);
    service.dispose();
  });

  test('requires same-renderer health before confirmation and expires previews', async () => {
    const { source, settings, service, setNow } = world();
    const imported = await service.importPath(source);
    assert.equal(imported.status, 'imported');
    if (imported.status !== 'imported') return;
    const preview = await service.preview(imported.theme.id, 7);
    assert.equal(preview.expiresAt, 1_000 + THEME_PREVIEW_MS);
    assert.equal(service.confirm(preview.previewId, 7).confirmed, false);
    assert.equal(service.healthy(preview.previewId, 8), false, 'another renderer cannot acknowledge the preview');
    assert.equal(service.healthy(preview.previewId, 7), true);
    const confirmed = service.confirm(preview.previewId, 7);
    assert.equal(confirmed.confirmed, true);
    assert.equal(settings.get().userTheme, imported.theme.id);

    const expiring = await service.preview(imported.theme.id, 7);
    setNow(expiring.expiresAt);
    assert.equal(service.healthy(expiring.previewId, 7), false);
    assert.equal(settings.get().userTheme, imported.theme.id);
    service.dispose();
  });

  test('heals a missing active file and removing/resetting restore first-party appearance', async () => {
    const { source, settings, service } = world();
    const imported = await service.importPath(source);
    assert.equal(imported.status, 'imported');
    if (imported.status !== 'imported') return;
    settings.set({ appearance: 'light', userTheme: imported.theme.id });
    assert.equal((await service.active()).theme?.id, imported.theme.id);

    const removal = await service.remove(imported.theme.id);
    assert.equal(removal.removed, true);
    assert.equal(removal.settings.userTheme, null);
    assert.equal(removal.settings.appearance, 'light', 'uninstall restores the prior first-party selection');

    settings.set({ appearance: 'system', userTheme: imported.theme.id });
    assert.deepEqual(await service.active(), { theme: null, notice: 'missing' });
    assert.equal(settings.get().userTheme, null);
    assert.equal(service.reset().appearance, 'dark');
    service.dispose();
  });
});

describe('theme template export (#397)', () => {
  const fullTokens = (): Record<string, string> => {
    const text = new Set(['--white-1', '--white-2', '--white-3', '--text-body', '--text-muted', '--text-faint', '--text-tertiary']);
    const accents = new Set([
      '--accent-iris',
      '--accent-cyan',
      '--accent-cyan-bright',
      '--accent-violet',
      '--accent-amber',
      '--accent-green',
      '--accent-red',
    ]);
    return Object.fromEntries(
      THEME_TOKENS.map((token) => {
        if (text.has(token)) return [token, '#f4f4f8'];
        if (accents.has(token)) return [token, '#8fa5ff'];
        if (token === '--text-on-accent' || token === '--on-danger-strong') return [token, '#101418'];
        return [token, '#161a20'];
      }),
    );
  };

  test('writes a complete, importable template and appends the theme suffix', async () => {
    const { root, service } = world();
    const destination = path.join(root, 'exports', 'my-template');
    const result = await service.exportTemplate(destination, { base: 'light', tokens: fullTokens() });
    assert.deepEqual(result, { status: 'exported', tokenCount: THEME_TOKENS.length, warnings: [] });

    const written = path.join(root, 'exports', 'my-template.overlook-theme.json');
    const parsed = JSON.parse(readFileSync(written, 'utf8')) as {
      meta: { base: string };
      tokens: Record<string, string>;
      docs: Record<string, string>;
    };
    assert.equal(parsed.meta.base, 'light');
    assert.deepEqual(Object.keys(parsed.tokens), [...THEME_TOKENS]);
    assert.deepEqual(Object.keys(parsed.docs), [...THEME_TOKENS]);

    const imported = await service.importPath(written);
    assert.equal(imported.status, 'imported');
    if (imported.status === 'imported') assert.equal(imported.theme.meta.name, 'Overlook light template');
    service.dispose();
  });

  test('refuses to write when any effective value is not a literal color', async () => {
    const { root, service } = world();
    const destination = path.join(root, 'broken.overlook-theme.json');
    const result = await service.exportTemplate(destination, {
      base: 'dark',
      tokens: { ...fullTokens(), '--selection': 'var(--accent-iris)' },
    });
    assert.equal(result.status, 'invalid');
    if (result.status === 'invalid')
      assert.deepEqual(
        result.errors.map((error) => error.path),
        ['tokens.--selection'],
      );
    assert.equal(existsSync(destination), false);
    service.dispose();
  });
});
