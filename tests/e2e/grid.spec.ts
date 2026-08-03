import { test, expect, _electron as electron } from '@playwright/test';

import { mkE2eTmpDir } from './support/tmp-dir.js';

// #74 exit criteria at the E2E level: the engine windows a library far
// larger than the viewport (synthetic metadata-only rows), pages the cursor
// as the scroll approaches the loaded frontier, and reports frame stats for
// the M11 budgets. The 200K manual baseline runs via `npm run seed:perf`;
// CI keeps a fast 2 000-row variant of the same path.
test('virtualizes and cursor-pages a synthetic library', async () => {
  const userData = mkE2eTmpDir('overlook-e2e-grid-');
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_SEED_SYNTHETIC: '2000',
      OVERLOOK_INSECURE_KEYSTORE: '1',
    },
  });
  try {
    const page = await app.firstWindow();
    const grid = page.getByTestId('virtual-grid');
    await expect(grid).toBeVisible();
    await expect(page.getByTestId('statusbar-left')).toContainText('2,000 photos ·');

    // Windowed rendering: only the visible rows (+overscan) are in the DOM.
    await expect(grid.locator('.ovl-grid__cell').first()).toBeVisible();
    const mounted = await grid.locator('.ovl-grid__cell').count();
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(400);

    // The scroll plane is sized for the whole library, not the loaded page.
    const planeBox = await grid.locator('.ovl-grid__plane').boundingBox();
    const gridBox = await grid.boundingBox();
    expect(planeBox === null || gridBox === null).toBe(false);
    expect((planeBox?.height ?? 0) > (gridBox?.height ?? 1) * 10).toBe(true);

    // Select All resolves the whole active library, not only the first cursor page.
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+A`);
    await expect(page.getByTestId('selection-pill')).toContainText('2,000 selected');
    await expect(grid.locator('[data-index="0"] .ovl-tile__select')).toHaveAttribute('aria-pressed', 'true');

    // Wheel to the bottom: the engine must page the cursor (4× limit 500)
    // until the final photo's tile renders as a real PhotoTile (#76), not
    // the loading placeholder.
    await grid.hover();
    const lastTile = grid.locator('.ovl-grid__cell[data-index="1999"] .ovl-tile');
    await expect(async () => {
      await page.mouse.wheel(0, 1_000_000);
      await expect(lastTile).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 15_000 });
    await expect(grid.locator('.ovl-grid__cell[data-index="1999"] .ovl-tile__select')).toHaveAttribute('aria-pressed', 'true');

    // Frame instrumentation recorded the scroll for M11's budgets.
    // type-coverage:ignore-next-line
    const stats = await page.evaluate(() => (globalThis as unknown as { __overlookFrameStats?: { frames: number } }).__overlookFrameStats);
    expect(stats !== undefined && stats.frames >= 0).toBe(true);
  } finally {
    await app.close();
  }
});
