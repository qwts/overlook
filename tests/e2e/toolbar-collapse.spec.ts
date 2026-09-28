import type { ElectronApplication, Page } from '@playwright/test';

import { expect, test } from './support/app.js';

// #1290 (Pass B spec §02, §08): the toolbar is one 48px row at every width
// and collapses in a fixed order instead of wrapping. Widths under the 960px
// window minimum are reached the way users reach them: by zooming the page.

interface RowState {
  readonly level: number;
  readonly height: number;
  readonly overflow: number;
}

async function showCssWidth(app: ElectronApplication, width: number): Promise<void> {
  const windowWidth = Math.max(960, width);
  await app.evaluate(
    ({ BrowserWindow }, { windowWidth, zoom }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setContentSize(windowWidth, 800);
      window?.webContents.setZoomFactor(zoom);
    },
    { windowWidth, zoom: windowWidth / width },
  );
}

// Evaluated as strings: the e2e project has no DOM lib.
const ROW_STATE = `(() => {
  const row = document.querySelector('.ovl-toolbar__row');
  return {
    level: Number(row.dataset.collapse),
    // Fractional zoom leaves sub-pixel remainders.
    height: Math.round(row.getBoundingClientRect().height),
    overflow: row.scrollWidth - row.clientWidth,
  };
})()`;

async function rowAt(page: Page, width: number): Promise<RowState> {
  // Fractional zoom can round the viewport by a pixel.
  await expect.poll(async () => Math.abs((await page.evaluate<number>('window.innerWidth')) - width)).toBeLessThanOrEqual(1);
  // One frame for the ResizeObserver, one for the render it triggers.
  await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  return page.evaluate<RowState>(ROW_STATE);
}

test('the toolbar is one row at the default window, fully expanded', async ({ launchOverlook }) => {
  const { page } = await launchOverlook({ prefix: 'overlook-e2e-toolbar-default-', env: { OVERLOOK_SEED: '12' } });
  await expect(page.locator('.ovl-toolbar__row')).toHaveAttribute('data-collapse', '0');
  await expect.poll(() => page.evaluate<RowState>(ROW_STATE)).toEqual({ level: 0, height: 48, overflow: 0 });
  await expect(page.getByRole('toolbar')).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Zoom' })).toBeVisible();
  await expect(page.locator('.ovl-toolbar').getByRole('button', { name: 'Import' })).toHaveText('Import');
});

test('a resize sweep from 1440 to 480 and back never wraps the toolbar', async ({ launchOverlook }) => {
  // pCloud on, the widest row any platform ships: Transfer & Sync and Export
  // All live in the Overlook menu (#1293), never in this row.
  const { app, page } = await launchOverlook({
    prefix: 'overlook-e2e-toolbar-sweep-',
    env: { OVERLOOK_SEED: '12', OVERLOOK_PCLOUD_ENABLED: '1', OVERLOOK_PCLOUD_CLIENT_ID: 'public-e2e-client' },
  });
  await expect(page.locator('.ovl-toolbar').getByRole('button', { name: /^(Transfer & Sync|Export All Unencrypted…)$/u })).toHaveCount(0);
  const widths = Array.from({ length: 25 }, (_, index) => 1440 - index * 40);
  let previous = 0;
  for (const width of widths) {
    await showCssWidth(app, width);
    const state = await rowAt(page, width);
    expect(state, `at ${width}px`).toEqual({ level: expect.any(Number), height: 48, overflow: 0 });
    expect(state.level, `at ${width}px`).toBeGreaterThanOrEqual(previous);
    previous = state.level;
  }
  // 480 is the 960px minimum window at 200%.
  expect(previous).toBe(4);
  await expect(page.getByRole('button', { name: /^View: / })).toBeVisible();
  await expect(page.locator('.ovl-toolbar').getByRole('button', { name: 'Import' })).toBeVisible();

  for (const width of [...widths].reverse()) {
    await showCssWidth(app, width);
    const state = await rowAt(page, width);
    expect(state, `at ${width}px`).toEqual({ level: expect.any(Number), height: 48, overflow: 0 });
    expect(state.level, `at ${width}px`).toBeLessThanOrEqual(previous);
    previous = state.level;
  }
  expect(previous).toBe(0);
});
