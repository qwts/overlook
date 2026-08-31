import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { THEME_TOKENS, validateThemeFile } from '../../src/shared/theme/theme-file.js';

const validTheme = {
  meta: { name: 'Northern lights', author: 'Overlook', version: '1.0.0', base: 'dark', tokensVersion: 1 },
  tokens: { '--accent-iris': '#8877ff' },
};

describe('user-theme contract (#396)', () => {
  test('exports one unique color-token allowlist without layout or gradient values', () => {
    assert.equal(new Set(THEME_TOKENS).size, THEME_TOKENS.length);
    assert.ok(THEME_TOKENS.includes('--surface-window'));
    assert.ok(THEME_TOKENS.includes('--selection'));
    assert.ok(!THEME_TOKENS.includes('--brand-gradient' as never));
    assert.ok(!THEME_TOKENS.includes('--focus-ring' as never));
  });

  test('validates and canonicalizes known tokens while warning on unknown tokens', () => {
    const result = validateThemeFile({
      ...validTheme,
      tokens: { ...validTheme.tokens, '--future-token': '#fff' },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.theme.cssTokens['--accent-iris'], 'rgb(53.33333% 46.66667% 100%)');
    assert.deepEqual(
      result.theme.warnings.filter((warning) => warning.kind === 'unknown-token'),
      [{ kind: 'unknown-token', token: '--future-token', message: '--future-token is unknown and will be skipped' }],
    );
  });

  test('returns actionable paths for schema and color failures', () => {
    const wrongVersion = validateThemeFile({ ...validTheme, meta: { ...validTheme.meta, tokensVersion: 2 } });
    assert.equal(wrongVersion.ok, false);
    if (!wrongVersion.ok) assert.deepEqual(wrongVersion.errors, [{ path: 'meta.tokensVersion', message: 'Invalid input: expected 1' }]);

    const hostile = validateThemeFile({ ...validTheme, tokens: { '--surface-window': 'url(https://attacker.invalid/a)' } });
    assert.equal(hostile.ok, false);
    if (!hostile.ok)
      assert.deepEqual(hostile.errors, [{ path: 'tokens.--surface-window', message: 'only a single literal CSS color is allowed' }]);
  });

  test('fails an all-unknown theme and hard-blocks functionally invisible body text', () => {
    const unknown = validateThemeFile({ ...validTheme, tokens: { '--future-token': '#fff' } });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.match(unknown.errors[0]?.message ?? '', /recognized color token/);

    const invisible = validateThemeFile({
      ...validTheme,
      tokens: { '--text-body': '#ffffff', '--surface-window': '#ffffff' },
    });
    assert.equal(invisible.ok, false);
    if (!invisible.ok) assert.match(invisible.errors[0]?.message ?? '', /minimum is 1\.5:1/);

    const translucent = validateThemeFile({
      ...validTheme,
      tokens: { '--text-body': 'rgb(0 0 0 / 10%)', '--surface-window': 'rgb(255 255 255 / 0%)' },
    });
    assert.equal(translucent.ok, false);
    if (!translucent.ok) assert.match(translucent.errors[0]?.message ?? '', /minimum is 1\.5:1/);
  });

  test('surfaces low-contrast warnings without blocking import', () => {
    const result = validateThemeFile({
      ...validTheme,
      tokens: { '--text-muted': '#777777', '--surface-window': '#777778' },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.theme.warnings.some((warning) => warning.kind === 'contrast' && warning.foreground === '--text-muted'));
  });
});
