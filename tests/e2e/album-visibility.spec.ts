import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { mkE2eTmpDir } from './support/tmp-dir.js';

async function launchSeeded(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkE2eTmpDir('overlook-e2e-album-visibility-');
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, OVERLOOK_USER_DATA: userData, OVERLOOK_SEED: '12', OVERLOOK_INSECURE_KEYSTORE: '1' },
  });
  const page = await app.firstWindow();
  await page.getByTestId('virtual-grid').waitFor();
  await page.locator('.ovl-tile__img').first().waitFor();
  return { app, page };
}

// #494 / ADR-0030 §2 acceptance over the real IPC boundary: hiding an album
// removes exactly its photos from All Photos (each seeded photo belongs to one
// album), the album's own view keeps them, the sidebar and status bar
// disclose the hidden count, and showing the album again restores every row
// without touching records.
//
// Seed geometry (src/main/library/seed.ts): 12 live photos over four albums,
// every 4th photo joining one album — "Family" holds indexes 1, 5, 9.
test('hiding an album from All Photos is disclosed, presentation-only, and reversible', async () => {
  const { app, page } = await launchSeeded();
  try {
    const grid = page.getByTestId('virtual-grid');
    await expect(page.getByRole('button', { name: 'All Photos 12' })).toBeVisible();
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(12);

    await page.getByRole('button', { name: 'Actions for Family' }).click();
    await page.getByRole('menuitem', { name: /Hide from All Photos/u }).click();

    await expect(page.getByRole('button', { name: 'All Photos 9' })).toBeVisible();
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(9);
    await expect(page.getByTestId('album-visibility-status')).toHaveText('3 photos hidden by album settings');
    await expect(page.getByTestId('statusbar-left')).toContainText('12 photos ·');
    const familyRow = page.locator('.ovl-sidebar__albumrow', { hasText: 'Family' }).locator(':scope > .ovl-siderow');
    await expect(familyRow.getByRole('img', { name: 'Hidden from All Photos' })).toBeVisible();
    await expect(familyRow).toContainText('3');

    // Exclusion changes one thing: the album still shows its own photos.
    await familyRow.click();
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(3);

    const listing = await page.evaluate<{ albums: { name: string; showInAllPhotos: boolean; visibleElsewhere: number }[] }>(
      'window.overlook.library.albums()',
    );
    expect(listing.albums.find((album) => album.name === 'Family')).toMatchObject({ showInAllPhotos: false, visibleElsewhere: 0 });

    await page.getByRole('button', { name: 'Actions for Family' }).click();
    await page.getByRole('menuitem', { name: /Show in All Photos/u }).click();
    await page.getByRole('button', { name: 'All Photos 12' }).click();
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(12);
    await expect(page.getByTestId('album-visibility-status')).toHaveCount(0);
    await expect(familyRow.getByRole('img', { name: 'Hidden from All Photos' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});
