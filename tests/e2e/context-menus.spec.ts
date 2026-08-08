import { expect, test } from './support/app.js';

test('context menus preserve selection, support keyboard focus, and empty Trash safely', async ({ launchOverlook }) => {
  const { page } = await launchOverlook({ prefix: 'overlook-e2e-context-menu-', env: { OVERLOOK_SEED: '3' } });
  await page.locator('.ovl-tile__img').first().waitFor();

  const openButtons = page.getByRole('button', { name: /^Open IMG_/u });
  await openButtons.nth(0).click({ button: 'right' });
  const singleMenu = page.getByRole('menu', { name: /Actions for IMG_/u });
  await expect(singleMenu.getByRole('menuitem', { name: 'Open' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(singleMenu.getByRole('menuitem', { name: 'Move photo to Trash' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(openButtons.nth(0)).toBeFocused();

  await page.locator('.ovl-tile__select').nth(1).click();
  await openButtons.nth(0).click({ button: 'right' });
  const selectionMenu = page.getByRole('menu', { name: 'Actions for 2 selected photos' });
  await expect(selectionMenu).toBeVisible();
  await selectionMenu.getByRole('menuitem', { name: 'Move photo to Trash' }).click();
  await expect(page.locator('.ovl-toast-host')).toContainText('Moved 2 photos to Trash');

  const trash = page.getByRole('button', { name: /^Trash \d+$/u });
  await trash.click();
  await expect(page.locator('.ovl-grid__cell')).toHaveCount(2);
  await trash.press('Shift+F10');
  const trashMenu = page.getByRole('menu', { name: 'Trash actions' });
  await trashMenu.getByRole('menuitem', { name: 'Empty Trash…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete 2 photos permanently?' });
  await expect(confirm).toContainText('This cannot be undone.');
  await confirm.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.locator('.ovl-toast-host')).toContainText('Deleted 2 photos permanently');
  await expect(page.getByTestId('empty-state')).toBeVisible();
});
