import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from './support/app.js';
import { mkE2eTmpDir } from './support/tmp-dir.js';

test('the exported theme template documents every token and re-imports as a no-op (#397)', async ({ launchOverlook }) => {
  const userData = mkE2eTmpDir('overlook-e2e-theme-template-');
  const destination = path.join(userData, 'exported.overlook-theme.json');

  const app = await launchOverlook({
    userData,
    env: { OVERLOOK_SEED: '2', OVERLOOK_THEME_EXPORT_DESTINATION: destination, OVERLOOK_THEME_IMPORT_SOURCE: destination },
  });
  try {
    const body = app.page.locator('body');
    const backgroundBefore = await app.page.evaluate<string>('getComputedStyle(document.body).backgroundColor');

    await app.page.getByRole('button', { name: 'Settings' }).click();
    await app.page.getByRole('tab', { name: 'General' }).click();
    await app.page.getByRole('button', { name: 'Export theme template' }).click();
    await expect(app.page.getByRole('status').filter({ hasText: /Exported a template with \d+ tokens/u })).toBeVisible();
    await expect.poll(() => existsSync(destination)).toBe(true);

    const template = JSON.parse(readFileSync(destination, 'utf8')) as {
      meta: { base: string; tokensVersion: number };
      tokens: Record<string, string>;
      docs: Record<string, string>;
    };
    expect(template.meta.base).toBe('dark');
    expect(template.meta.tokensVersion).toBe(1);
    const tokenNames = Object.keys(template.tokens);
    expect(tokenNames.length).toBeGreaterThanOrEqual(50);
    expect(Object.keys(template.docs)).toEqual(tokenNames);
    for (const value of Object.values(template.tokens)) expect(value).not.toMatch(/var\(|url\(|Canvas/u);

    await app.page.getByRole('button', { name: /Choose or drop one .*overlook-theme\.json file/u }).click();
    await expect(app.page.getByRole('dialog', { name: 'Keep this theme?' })).toBeVisible();
    await app.page.getByRole('button', { name: 'Keep theme' }).click();
    await expect(app.page.getByText('Active')).toBeVisible();
    await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(body).toHaveCSS('background-color', backgroundBefore);
  } finally {
    await app.close();
  }
});
