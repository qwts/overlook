import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

interface ContrastResult {
  readonly checks: number;
  readonly themes: readonly string[];
  readonly failures: readonly string[];
}

interface ContrastModule {
  evaluateColorContrast(source: string): ContrastResult;
}

test('contrast gate composes both high-contrast palettes and enforces their UI pairs (#651)', async () => {
  const checker = (await import(pathToFileURL(join(process.cwd(), 'scripts/check-color-contrast.mjs')).href)) as ContrastModule;
  const source = await readFile(join(process.cwd(), 'src/renderer/src/styles/tokens/colors.css'), 'utf8');

  const passing = checker.evaluateColorContrast(source);
  assert.deepEqual(passing.themes, ['dark', 'light', 'dark-high-contrast', 'light-high-contrast']);
  assert.equal(passing.checks, 168);
  assert.deepEqual(passing.failures, []);

  const brokenDarkHighContrast = source.replace('--border-1: #cfd6e3;', '--border-1: #000000;');
  const failing = checker.evaluateColorContrast(brokenDarkHighContrast);
  assert.ok(
    failing.failures.some((failure) => failure.startsWith('dark-high-contrast: --border-1 on --surface-window = 1.00:1; needs 3.0:1')),
  );
});
