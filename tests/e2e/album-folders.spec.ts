import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { mkE2eTmpDir } from './support/tmp-dir.js';

async function launchSeeded(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkE2eTmpDir('overlook-e2e-album-folders-');
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, OVERLOOK_USER_DATA: userData, OVERLOOK_SEED: '12', OVERLOOK_INSECURE_KEYSTORE: '1' },
  });
  const page = await app.firstWindow();
  await page.getByTestId('virtual-grid').waitFor();
  await page.locator('.ovl-tile__img').first().waitFor();
  return { app, page };
}

// #505 / ADR-0030 §1, §2, §5 acceptance over the real IPC boundary: folders
// nest albums (created inside, or moved in), a folder's All Photos policy is
// the default for children that have not set their own and the child can
// override it or follow it again, disclosure state survives a relaunch as
// per-profile view state, and deleting a non-empty folder names exactly the
// structure it removes while every photo stays.
//
// Seed geometry (src/main/library/seed.ts): 12 live photos over four albums,
// every 4th photo joining one album — "Family" holds indexes 1, 5, 9.
test('album folders: nest, inherit visibility, collapse across relaunch, delete with a counted ceremony', async () => {
  test.setTimeout(90_000);
  const { app, page } = await launchSeeded();
  try {
    const names = (): Promise<string[]> => page.locator('.ovl-sidebar__albumrow > .ovl-siderow .ovl-siderow__label').allTextContents();
    const row = (name: string) =>
      page.locator('.ovl-sidebar__albumrow', { has: page.locator(`:scope > .ovl-siderow:has-text("${name}")`) });
    const rowButton = (name: string) => row(name).locator(':scope > .ovl-siderow');
    const allPhotos = (count: number) => page.getByRole('button', { name: `All Photos ${String(count)}` });
    await expect(allPhotos(12)).toBeVisible();
    const existing = await names();

    // Create a folder from the heading, then an album inside it from the folder's menu.
    await page.getByRole('button', { name: 'New folder' }).click();
    await page.getByRole('textbox', { name: 'Folder name' }).fill('Trips');
    await page.getByRole('textbox', { name: 'Folder name' }).press('Enter');
    await expect(row('Trips')).toHaveAttribute('data-kind', 'folder');
    await expect(rowButton('Trips')).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: 'Actions for Trips' }).click();
    await page.getByRole('menuitem', { name: 'New album inside…' }).click();
    await page.getByRole('textbox', { name: 'Album name' }).fill('Hokkaido');
    await page.getByRole('textbox', { name: 'Album name' }).press('Enter');
    await expect(row('Hokkaido')).toHaveAttribute('data-depth', '1');

    // Move an existing album into the folder: it lands last among the children.
    await page.getByRole('button', { name: 'Actions for Family' }).click();
    await page.getByRole('menuitem', { name: 'Move to folder…' }).click();
    await page.getByRole('combobox', { name: 'Folder' }).selectOption({ label: 'Trips' });
    await page.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(row('Family')).toHaveAttribute('data-depth', '1');
    await expect.poll(names).toEqual(['Trips', 'Hokkaido', 'Family', ...existing.filter((name) => name !== 'Family')]);
    await expect(rowButton('Trips')).toContainText('3');
    await expect(page.locator('.ovl-toast-host')).toContainText('Moved Family to Trips');

    // Folder policy is the default for its children: hiding the folder hides Family's 3 photos.
    await page.getByRole('button', { name: 'Actions for Trips' }).click();
    await page.getByRole('menuitem', { name: /Hide from All Photos/u }).click();
    await expect(allPhotos(9)).toBeVisible();
    await expect(rowButton('Family').getByRole('img', { name: 'Hidden from All Photos' })).toBeVisible();
    await page.getByRole('button', { name: 'Actions for Family' }).click();
    await expect(page.getByRole('menuitem', { name: /Show in All Photos.*Follows the folder setting/u })).toBeVisible();
    // An explicit setting on the child wins, and the child can follow the folder again.
    await page.getByRole('menuitem', { name: /Show in All Photos/u }).click();
    await expect(allPhotos(12)).toBeVisible();
    await page.getByRole('button', { name: 'Actions for Family' }).click();
    await page.getByRole('menuitem', { name: 'Use folder setting' }).click();
    await expect(allPhotos(9)).toBeVisible();

    // Disclosure is per-profile view state: it survives a reload and never changes what All Photos shows.
    await rowButton('Trips').click();
    await expect(rowButton('Trips')).toHaveAttribute('aria-expanded', 'false');
    await expect(row('Family')).toHaveCount(0);
    await page.reload();
    await page.locator('.ovl-tile__img').first().waitFor();
    await expect(rowButton('Trips')).toHaveAttribute('aria-expanded', 'false');
    await expect(row('Hokkaido')).toHaveCount(0);
    await expect(allPhotos(9)).toBeVisible();
    await rowButton('Trips').click();
    await expect(row('Hokkaido')).toHaveAttribute('data-depth', '1');

    // Tags are a separate vocabulary shown on the menu, never on photos.
    await page.getByRole('button', { name: 'Actions for Trips' }).click();
    await page.getByRole('menuitem', { name: 'Tags…' }).click();
    await page.getByRole('textbox', { name: 'Tags, separated by commas' }).fill('travel, Travel, 2026');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.ovl-toast-host')).toContainText('Saved tags for Trips');
    await page.getByRole('button', { name: 'Actions for Trips' }).click();
    await expect(page.getByRole('menuitem', { name: /Tags….*2026, travel/u })).toBeVisible();

    // Deleting the folder recursively names the structure it removes; photos return to All Photos.
    await page.getByRole('menuitem', { name: 'Delete folder…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete folder' });
    await expect(dialog).toContainText('Photos stay in the library');
    await dialog.getByRole('radio', { name: 'Also delete 2 albums inside it' }).check();
    await dialog.getByRole('button', { name: 'Delete folder' }).click();
    await expect.poll(names).toEqual(existing.filter((name) => name !== 'Family'));
    await expect(allPhotos(12)).toBeVisible();
    await expect(page.locator('.ovl-toast-host')).toContainText('Deleted Trips · 1 folder, 2 albums removed · photos kept');
    await expect(page.getByTestId('statusbar-left')).toContainText('12 photos');
  } finally {
    await app.close();
  }
});
