import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { mkE2eTmpDir } from './support/tmp-dir.js';

async function launchSeeded(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkE2eTmpDir('overlook-e2e-feed-view-');
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, OVERLOOK_USER_DATA: userData, OVERLOOK_SEED: '12', OVERLOOK_INSECURE_KEYSTORE: '1' },
  });
  const page = await app.firstWindow();
  await page.getByTestId('virtual-grid').waitFor();
  await page.locator('.ovl-tile__img').first().waitFor();
  return { app, page };
}

// #516 acceptance over the real app: the Feed is a layout of the same
// virtualized engine (only the window mounts), each card carries the title
// (file name until one is set), the image, and the description (a compact
// placeholder until one is set), keyboard navigation walks the cards, the
// scroll position survives a lightbox round trip, and a favorite toggle or a
// metadata edit repaints the visible card in place.
//
// Seed geometry (src/main/library/seed.ts): 12 live photos named
// IMG_4021 + 7·index, RAW at every fifth index, no titles or descriptions.
test('feed view: cards, keyboard, lightbox return, and in-place updates', async () => {
  test.setTimeout(120_000);
  const { app, page } = await launchSeeded();
  try {
    const grid = page.getByTestId('virtual-grid');
    const cells = grid.locator('.ovl-grid__cell');
    const card = (position: number) => grid.locator(`.ovl-grid__cell[aria-posinset="${String(position)}"] .ovl-feedcard`);
    const openButton = (position: number) => card(position).getByRole('button', { name: /^Open / });
    await expect(cells).toHaveCount(12);

    // Switch to the Feed: a reading-width column of cards, windowed by the engine.
    await page.getByRole('radio', { name: 'Feed' }).click();
    await expect(grid).toHaveClass(/ovl-grid--feed/u);
    await expect(card(1)).toBeVisible();
    expect(await cells.count()).toBeLessThan(12);
    await expect(card(1).locator('.ovl-feedcard__title')).toHaveText('IMG_4021.RAF');
    await expect(card(1).locator('.ovl-feedcard__title')).toHaveClass(/ovl-feedcard__title--fallback/u);
    await expect(card(1).locator('.ovl-feedcard__description')).toHaveText('No description');
    await expect(card(1).locator('.ovl-feedcard__frame')).toHaveAttribute('data-state', 'loaded');
    await expect(page.getByRole('slider', { name: 'Zoom' })).toBeHidden();

    // Keyboard: the arrow keys walk the single column, scrolling the window
    // along (Home and End stay within the row, as in the grid). Focus lands on
    // the next animation frame, so each step waits for it before the next key.
    await openButton(1).focus();
    await page.keyboard.press('End');
    await expect(openButton(1)).toBeFocused();
    for (let position = 2; position <= 12; position += 1) {
      await page.keyboard.press('ArrowDown');
      await expect(openButton(position)).toBeFocused();
    }
    await expect(card(12)).toBeVisible();
    const scrolled = await page.evaluate<number>('document.getElementById("photo-grid").scrollTop');
    expect(scrolled).toBeGreaterThan(0);

    // The lightbox overlays the mounted feed: closing lands on the same card.
    await page.keyboard.press('Enter');
    const close = page.getByRole('button', { name: 'Close (Esc)' });
    await expect(close).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(close).toBeHidden();
    await expect(card(12)).toBeVisible();
    expect(await page.evaluate<number>('document.getElementById("photo-grid").scrollTop')).toBe(scrolled);

    // A favorite toggle repaints the card in place.
    await card(12).getByRole('button', { name: 'Add to Favorites' }).click();
    await expect(card(12).getByRole('button', { name: 'Remove from Favorites' })).toHaveAttribute('aria-pressed', 'true');

    // A title and description written in the Inspector flow to the visible card.
    await card(12).getByRole('button', { name: 'Select IMG_4098.JPG' }).click();
    await page.keyboard.press('i');
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await expect(inspector).toBeVisible();
    await inspector.getByLabel('Title').fill('Last light');
    await inspector.getByLabel('Description').fill('The final frame of the seeded walk.');
    await inspector.getByRole('button', { name: 'Save metadata' }).click();
    await expect(card(12).locator('.ovl-feedcard__title')).toHaveText('Last light');
    await expect(card(12).locator('.ovl-feedcard__title')).not.toHaveClass(/ovl-feedcard__title--fallback/u);
    await expect(card(12).locator('.ovl-feedcard__meta')).toContainText('IMG_4098.JPG');
    await expect(card(12).locator('.ovl-feedcard__description')).toHaveText('The final frame of the seeded walk.');

    // Back to the grid: the same engine, the same photos.
    await page.getByRole('radio', { name: 'Grid' }).click();
    await expect(grid).not.toHaveClass(/ovl-grid--feed/u);
    await expect(page.locator('.ovl-tile__img').first()).toBeVisible();
  } finally {
    await app.close();
  }
});
