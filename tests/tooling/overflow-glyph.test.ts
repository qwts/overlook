import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

// UI-19 (#1303): `ellipsis` is the only More/overflow glyph app-wide. `sliders-horizontal`
// survives only where it means settings, never on a control that opens more actions.
const SETTINGS_ONLY = new Set(['src/renderer/src/settings/ProviderCard.tsx', 'src/renderer/src/settings/SettingsDialog.tsx']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry.name) && !/\.(stories|test)\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

test('sliders-horizontal appears only on settings controls, never on More/overflow (#1303)', () => {
  const root = process.cwd();
  const offenders = sourceFiles(join(root, 'src/renderer/src'))
    .map((path) => relative(root, path))
    .filter((file) => !file.endsWith('components/Icon.tsx') && !SETTINGS_ONLY.has(file))
    .filter((file) => readFileSync(join(root, file), 'utf8').includes('sliders-horizontal'));
  assert.deepEqual(offenders, []);
});
