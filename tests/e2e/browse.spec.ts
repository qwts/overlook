import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { mkE2eTmpDir } from './support/tmp-dir.js';

// M04 acceptance flows (#82) against the deterministic seeded profile —
// each flow is its own test so a regression names the broken flow, not a
// 100-line composite. Ledger: tests/e2e/coverage-map.json.

async function launchSeeded(seed = '12'): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkE2eTmpDir('overlook-e2e-browse-');
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_SEED: seed,
      OVERLOOK_INSECURE_KEYSTORE: '1',
    },
  });
  const page = await app.firstWindow();
  await page.getByTestId('virtual-grid').waitFor();
  // Wait for a REAL tile: placeholder cells render before the first page
  // lands, and keyboard flows (⌘A) read state.photos — acting earlier is
  // the #189 cold-start flake.
  await page.locator('.ovl-tile__img').first().waitFor();
  return { app, page };
}

test('browse + zoom: tiles render thumbs and rescale with the slider', async () => {
  const { app, page } = await launchSeeded();
  try {
    await expect(page.getByTestId('virtual-grid').locator('.ovl-grid__cell')).toHaveCount(12);
    await expect(page.locator('.ovl-tile__img').first()).toHaveJSProperty('naturalWidth', 1280);

    const before = await page.locator('.ovl-grid__cell').first().boundingBox();
    await page.getByRole('slider', { name: 'Zoom' }).fill('320');
    await expect(async () => {
      const after = await page.locator('.ovl-grid__cell').first().boundingBox();
      expect((after?.width ?? 0) > (before?.width ?? 0)).toBe(true);
    }).toPass({ timeout: 5000 });
  } finally {
    await app.close();
  }
});

test('grid↔list toggle preserves selection; slider hides in list', async () => {
  const { app, page } = await launchSeeded();
  try {
    await page.locator('.ovl-tile__select').first().click();
    await expect(page.locator('.ovl-tile--selected')).toHaveCount(1);
    await page.getByRole('radio', { name: 'List' }).click();
    await expect(page.locator('.ovl-listrow')).toHaveCount(12);
    await expect(page.getByRole('slider', { name: 'Zoom' })).toBeHidden();
    await expect(page.locator('.ovl-listrow--selected')).toHaveCount(1);
    await page.getByRole('radio', { name: 'Grid' }).click();
    await expect(page.locator('.ovl-tile--selected')).toHaveCount(1);
    await expect(page.getByRole('slider', { name: 'Zoom' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('search + chips filter the library live; impossible filter shows the empty state', async () => {
  const { app, page } = await launchSeeded();
  try {
    const grid = page.getByTestId('virtual-grid');
    const search = page.getByRole('searchbox', { name: 'Search library' });
    await search.fill('lisbon');
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(2);
    await search.fill('zzz-no-match');
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await search.fill('');
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(12);

    await page.getByRole('button', { name: 'Filters' }).click();
    const rawFilter = page.getByRole('button', { name: 'RAW' });
    await expect(rawFilter).toBeVisible();
    await rawFilter.press('Enter');
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(3);
    await rawFilter.press('Enter');
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(12);
  } finally {
    await app.close();
  }
});

test('selection: pointer, ⌘/Ctrl+A, Esc, pill survival across sources', async () => {
  const { app, page } = await launchSeeded();
  try {
    await page.keyboard.press('ControlOrMeta+a');
    await expect(page.getByTestId('selection-pill')).toContainText('12 selected');
    // Mock survival semantics: only still-visible photos stay selected.
    await page.getByRole('button', { name: 'Favorites 2' }).click();
    await expect(page.getByTestId('selection-pill')).toContainText('2 selected');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('selection-pill')).toHaveCount(0);
    // Clear-× path too.
    await page.keyboard.press('ControlOrMeta+a');
    await page.getByRole('button', { name: 'Clear selection' }).click();
    await expect(page.getByTestId('selection-pill')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('selection: Shift range spans virtualized rows in the full active library', async () => {
  const { app, page } = await launchSeeded('120');
  try {
    const grid = page.getByTestId('virtual-grid');
    await grid.locator('.ovl-grid__cell[aria-posinset="1"] .ovl-tile__select').click();
    await grid.evaluate((node) => {
      const element = node as unknown as { scrollTop: number; scrollHeight: number; dispatchEvent: (event: Event) => void };
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    const last = grid.locator('.ovl-grid__cell[aria-posinset="120"] .ovl-tile__select');
    await last.waitFor();
    await last.click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('selection-pill')).toContainText('120 selected');

    await grid.evaluate((node) => {
      const element = node as unknown as { scrollTop: number; dispatchEvent: (event: Event) => void };
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(grid.locator('.ovl-grid__cell[aria-posinset="1"] .ovl-tile__select')).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await app.close();
  }
});

test('sidebar: source switching refilters; counts live-update on mutation', async () => {
  const { app, page } = await launchSeeded();
  try {
    const grid = page.getByTestId('virtual-grid');
    await page.getByRole('button', { name: 'Favorites 2' }).click();
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(2);
    await page.getByRole('button', { name: 'All Photos 12' }).click();
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(12);
    // Albums went live with #117: a seed album filters the grid like a
    // source and hands back to All Photos cleanly.
    await page.getByRole('button', { name: 'Travel 2026 3' }).click();
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(3);
    await page.getByRole('button', { name: 'All Photos 12' }).click();
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(12);

    const addedPhoto = page.getByRole('button', { name: 'Open IMG_4028.JPG' }).locator('..');
    const addFavorite = addedPhoto.getByRole('button', { name: 'Add to Favorites' });
    await expect(addFavorite).toHaveAttribute('aria-pressed', 'false');
    await addFavorite.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Favorites 3' })).toBeVisible();

    // PR #167/#169 review: the VISIBLE page refreshes on mutation too —
    // while viewing Favorites, un-favoriting drops the row, not just the
    // sidebar count.
    await page.getByRole('button', { name: 'Favorites 3' }).click();
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(3);
    const removeFavorite = page
      .getByRole('button', { name: 'Open IMG_4028.JPG' })
      .locator('..')
      .getByRole('button', { name: 'Remove from Favorites' });
    await expect(removeFavorite).toHaveAttribute('aria-pressed', 'true');
    await removeFavorite.focus();
    await page.keyboard.press('Enter');
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Favorites 2' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('chrome truth: statusbar, backup button and card reflect pending state', async () => {
  const { app, page } = await launchSeeded();
  try {
    await expect(page.getByTestId('statusbar-left')).toContainText('12 photos ·');
    await expect(page.getByTestId('sync-state')).toContainText('Encrypting 4 → Local mock');
    await expect(page.getByTestId('backup-card')).toContainText('Library encrypted');
    // The card shows the real storage split (#108); the progress bar only
    // renders during an active run. The full run choreography lives in
    // backup.spec.ts.
    await expect(page.getByTestId('backup-card')).toContainText('on disk');
    await expect(page.getByTestId('backup-card')).toContainText('offload (Local mock)');
    const backup = page.getByRole('button', { name: 'Back up' });
    await expect(backup).toBeEnabled();
  } finally {
    await app.close();
  }
});
