import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { parseCssColor } from '../../src/shared/theme/css-color.js';
import { THEME_CONTRAST_PAIRS, THEME_TOKENS, validateThemeFile, type ThemeToken } from '../../src/shared/theme/theme-file.js';
import { THEME_TOKEN_DOCS, buildThemeTemplate } from '../../src/shared/theme/theme-template.js';

const textTokens = new Set<ThemeToken>([
  '--white-1',
  '--white-2',
  '--white-3',
  '--text-body',
  '--text-muted',
  '--text-faint',
  '--text-tertiary',
]);
const accentTokens = new Set<ThemeToken>([
  '--accent-iris',
  '--accent-cyan',
  '--accent-cyan-bright',
  '--accent-violet',
  '--accent-amber',
  '--accent-green',
  '--accent-red',
]);

function effectiveDark(): Record<string, string> {
  return Object.fromEntries(
    THEME_TOKENS.map((token) => {
      if (textTokens.has(token)) return [token, 'oklch(0.95 0.004 250)'];
      if (accentTokens.has(token)) return [token, 'oklch(0.72 0.15 278)'];
      if (token === '--text-on-accent' || token === '--on-danger-strong') return [token, '#101418'];
      if (token.endsWith('-dim')) return [token, 'rgb(120 110 255 / 16%)'];
      return [token, '#161a20'];
    }),
  );
}

describe('theme template export (#397, ADR-0019 §6)', () => {
  test('documents every allowlisted token exactly once', () => {
    assert.deepEqual(Object.keys(THEME_TOKEN_DOCS).sort(), [...THEME_TOKENS].sort());
    for (const [token, doc] of Object.entries(THEME_TOKEN_DOCS)) assert.ok(doc.trim().length > 20, `${token} needs a real description`);
  });

  test('embeds the §4 contrast-pair list the importer enforces', () => {
    // 4 text × 4 surface, --text-on-accent × 6 accents, --accent-cyan / window.
    assert.equal(THEME_CONTRAST_PAIRS.length, 4 * 4 + 6 + 1);
    for (const pair of THEME_CONTRAST_PAIRS) {
      assert.ok(THEME_TOKENS.includes(pair.foreground), pair.foreground);
      assert.ok(THEME_TOKENS.includes(pair.background), pair.background);
      assert.equal(pair.warnAt, 4.5);
      assert.equal(pair.blockAt, pair.foreground === '--text-body' ? 1.5 : undefined);
    }
    const built = buildThemeTemplate({ base: 'light', tokens: effectiveDark() });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.deepEqual(built.template.contrastPairs, THEME_CONTRAST_PAIRS);
    // A hand-edited pair list is reserved data: it neither breaks import nor changes what is checked.
    const edited = validateThemeFile({ ...JSON.parse(JSON.stringify(built.template)), contrastPairs: [] } as unknown);
    assert.equal(edited.ok, true);
  });

  test('builds a template that round-trips through the importer as a no-op', () => {
    const input = effectiveDark();
    const built = buildThemeTemplate({ base: 'dark', tokens: input });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.deepEqual(Object.keys(built.template.tokens), [...THEME_TOKENS]);
    assert.deepEqual(Object.keys(built.template.docs), [...THEME_TOKENS]);
    assert.deepEqual(built.template.contrastPairs, THEME_CONTRAST_PAIRS);
    assert.equal(built.template.meta.base, 'dark');
    assert.equal(built.template.meta.tokensVersion, 1);

    const imported = validateThemeFile(JSON.parse(JSON.stringify(built.template)) as unknown);
    assert.equal(imported.ok, true);
    if (!imported.ok) return;
    assert.deepEqual(
      imported.theme.warnings.filter((warning) => warning.kind === 'unknown-token'),
      [],
    );
    for (const token of THEME_TOKENS) {
      assert.equal(imported.theme.cssTokens[token], parseCssColor(input[token] ?? '').css, token);
    }
  });

  test('fails closed on forced-colors keywords, unresolved references, and missing tokens', () => {
    const forced = buildThemeTemplate({ base: 'dark', tokens: { ...effectiveDark(), '--gray-0': 'Canvas' } });
    assert.equal(forced.ok, false);
    if (!forced.ok)
      assert.deepEqual(
        forced.errors.map((error) => error.path),
        ['tokens.--gray-0'],
      );

    const unresolved = buildThemeTemplate({ base: 'light', tokens: { ...effectiveDark(), '--selection': 'var(--accent-cyan)' } });
    assert.equal(unresolved.ok, false);
    if (!unresolved.ok) assert.match(unresolved.errors[0]?.message ?? '', /single literal CSS color/);

    const { '--scrim': _scrim, ...missing } = effectiveDark();
    const partial = buildThemeTemplate({ base: 'dark', tokens: missing });
    assert.equal(partial.ok, false);
    if (!partial.ok) assert.deepEqual(partial.errors, [{ path: 'tokens.--scrim', message: '--scrim has no effective value to export' }]);
  });

  test('the theming reference names every token and the example themes import cleanly', () => {
    const reference = readFileSync(path.join('docs', 'Theming.md'), 'utf8');
    for (const token of THEME_TOKENS) assert.ok(reference.includes(`\`${token}\``), `docs/Theming.md must document ${token}`);

    const examplesDirectory = path.join('docs', 'themes');
    const examples = readdirSync(examplesDirectory).filter((name) => name.endsWith('.overlook-theme.json'));
    assert.ok(examples.length >= 2, 'ship at least two example themes');
    for (const name of examples) {
      const result = validateThemeFile(JSON.parse(readFileSync(path.join(examplesDirectory, name), 'utf8')) as unknown);
      assert.equal(result.ok, true, `${name} must validate`);
      if (result.ok) assert.deepEqual(result.theme.warnings, [], `${name} must import without warnings`);
    }
  });
});
