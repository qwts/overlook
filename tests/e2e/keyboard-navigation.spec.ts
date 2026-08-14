import { expect, test } from './support/app.js';

test('keyboard-only browse, search, selection, help, and lightbox tour (#399)', async ({ launchOverlook }) => {
  const { page } = await launchOverlook({ prefix: 'overlook-e2e-keyboard-', env: { OVERLOOK_SEED: '12' } });
  await page.locator('.ovl-tile__img').first().waitFor();
  {
    await expect(page.locator('.ovl-search__hint')).toHaveText(process.platform === 'darwin' ? '⌘K' : 'Ctrl+K');
    const skipLink = page.getByRole('link', { name: 'Skip to photos' });
    await skipLink.focus();
    await expect(skipLink).toBeVisible();
    await page.keyboard.press('Enter');

    const focusTargets = page.locator('[data-grid-focus-target="true"]');
    await expect(focusTargets.first()).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(focusTargets.nth(1)).toBeFocused();
    await page.keyboard.press('Shift+ArrowRight');
    await expect(focusTargets.nth(2)).toBeFocused();
    await expect(page.locator('.ovl-tile--selected')).toHaveCount(2);

    await page.keyboard.press('Shift+/');
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(help).toContainText('Move focus right');
    await expect(help).toContainText('Select all photos');
    await page.keyboard.press('i');
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(help).toHaveCount(0);
    await expect(focusTargets.nth(2)).toBeFocused();

    await page.keyboard.press('ControlOrMeta+k');
    const search = page.getByRole('searchbox', { name: 'Search library' });
    await expect(search).toBeFocused();
    await page.keyboard.press('ControlOrMeta+a');
    await expect(page.getByTestId('selection-pill')).toContainText('2 selected');
    await page.keyboard.press('Shift+/');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);

    await focusTargets.nth(2).focus();
    await expect(focusTargets.nth(2)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('lightbox')).toBeVisible();
    await page.keyboard.press('Shift+/');
    const lightboxHelp = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(lightboxHelp).toContainText('Zoom in');
    await expect(lightboxHelp).toContainText('Toggle favorite');
    await expect(lightboxHelp).toContainText('Move photo to Trash');
    await expect(lightboxHelp).toContainText('Rotate clockwise');
    await expect(lightboxHelp).toContainText(/(?:⌥|Alt\+)R/u);
    await expect(lightboxHelp).toContainText('Flip vertically');
    await expect(lightboxHelp).toContainText(/(?:⌥|Alt\+)H/u);
    await page.keyboard.press('Escape');
    await expect(lightboxHelp).toHaveCount(0);
    await page.keyboard.press('i');
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('lightbox')).toHaveCount(0);
  }
});
