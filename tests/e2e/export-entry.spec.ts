import { test, expect, _electron as electron } from '@playwright/test';

import { mkE2eTmpDir } from './support/tmp-dir.js';

// #100 exit criteria: both design entry points open the ExportDialog with
// exact counts — the selection pill's Export and the lightbox share icon —
// and the selection survives the flow.
test('export entry points: pill opens with the selection count, lightbox with count=1', async () => {
  const userData = mkE2eTmpDir('overlook-e2e-export-entry-');
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_SEED: '4',
      OVERLOOK_INSECURE_KEYSTORE: '1',
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    await page.locator('.ovl-tile__img').first().waitFor();

    // Select two photos → the pill's Export opens with the exact count.
    await page.locator('.ovl-grid__cell').nth(1).getByRole('button', { name: 'Select' }).click();
    await page.locator('.ovl-grid__cell').nth(2).getByRole('button', { name: 'Select' }).click();
    await page.getByTestId('selection-pill').getByRole('button', { name: 'Export' }).click();
    // Scoped to the dialog: the selection announcer can still be saying the
    // same words in its live region.
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('2 photos selected')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export 2 photos' })).toBeVisible();

    // Cancel: the dialog closes and the selection is preserved.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('selection-pill')).toContainText('2 selected');

    // Lightbox entry: the share icon opens with count=1 (the focused photo).
    await page.locator('.ovl-grid__cell').first().click();
    await expect(page.getByTestId('lightbox')).toBeVisible();
    await page.getByTestId('lightbox').getByRole('button', { name: 'Export' }).click();
    await expect(dialog.getByText('1 photo selected')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export 1 photo', exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});
