import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from './support/app.js';
import { mkE2eTmpDir } from './support/tmp-dir.js';

test('a validated user theme previews, persists across restart, and removes back to the first-party appearance (#396)', async ({
  launchOverlook,
}) => {
  const userData = mkE2eTmpDir('overlook-e2e-theme-manager-');
  const source = path.join(userData, 'orchid.overlook-theme.json');
  writeFileSync(
    source,
    JSON.stringify({
      meta: { name: 'Orchid', author: 'E2E', version: '1.0.0', base: 'light', tokensVersion: 1 },
      tokens: { '--surface-window': '#faebff', '--accent-iris': '#5f40c0', '--text-body': '#171221' },
    }),
    'utf8',
  );

  const first = await launchOverlook({
    userData,
    env: { OVERLOOK_SEED: '2', OVERLOOK_THEME_IMPORT_SOURCE: source },
  });
  try {
    await first.page.getByRole('button', { name: 'Settings' }).click();
    await first.page.getByRole('tab', { name: 'General' }).click();
    await first.page.getByRole('button', { name: /Choose or drop one .*overlook-theme\.json file/u }).click();
    await expect(first.page.getByRole('dialog', { name: 'Keep this theme?' })).toBeVisible();
    await expect(first.page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(first.page.locator('body')).toHaveCSS('background-color', 'rgb(250, 235, 255)');
    expect(await first.page.evaluate<number>('document.adoptedStyleSheets.length')).toBeGreaterThan(0);
    await first.page.getByRole('button', { name: 'Keep theme' }).click();
    await expect(first.page.getByText('Active')).toBeVisible();
    await expect
      .poll(() => first.page.evaluate<string | null>('window.overlook.settings.get().then(({ settings }) => settings.userTheme)'))
      .toMatch(/^orchid-[a-f0-9]{12}$/u);
  } finally {
    await first.close();
  }

  const second = await launchOverlook({ userData, env: { OVERLOOK_SEED: '2' } });
  try {
    await expect(second.page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(second.page.locator('body')).toHaveCSS('background-color', 'rgb(250, 235, 255)');
    await second.page.getByRole('button', { name: 'Settings' }).click();
    await second.page.getByRole('tab', { name: 'General' }).click();
    await expect(second.page.getByText('Orchid')).toBeVisible();
    await second.page.getByRole('button', { name: 'Remove' }).click();
    await expect(second.page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(second.page.getByText('No custom themes installed.')).toBeVisible();
  } finally {
    await second.close();
  }
});
