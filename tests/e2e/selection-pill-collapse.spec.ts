import type { ElectronApplication, Page } from '@playwright/test';

import { expect, test } from './support/app.js';

// #1304 (Pass E spec): the selection pill collapses one action at a time into
// ⋯ by the room its content area gives it, never the window's, and stays one
// line. Widths under the 960px window minimum are reached by zooming.

interface PillState {
  readonly level: number;
  readonly overflow: number;
  readonly height: number;
  /** Room the pill leaves inside its content area's 16px gutters. */
  readonly spare: number;
  readonly area: number;
  readonly more: boolean;
}

// Evaluated as strings: the e2e project has no DOM lib.
const PILL_STATE = `(() => {
  const pill = document.querySelector('.ovl-pill');
  const area = document.querySelector('.ovl-pill-anchor').getBoundingClientRect();
  const box = pill.getBoundingClientRect();
  const more = pill.querySelector('.ovl-pill__more button');
  return {
    level: Number(pill.dataset.collapse),
    overflow: pill.scrollWidth - pill.clientWidth,
    height: Math.round(box.height),
    spare: Math.round(Math.min(box.left - area.left, area.right - box.right) - 16),
    area: Math.round(area.width),
    more: more !== null && more.getClientRects().length > 0,
  };
})()`;

async function settled(page: Page): Promise<PillState> {
  // One frame for the ResizeObserver, one for the render it triggers.
  await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  return page.evaluate<PillState>(PILL_STATE);
}

async function setWindow(app: ElectronApplication, width: number, zoom = 1): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, { width, zoom }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setContentSize(width, 800);
      window?.webContents.setZoomFactor(zoom);
    },
    { width, zoom },
  );
}

function expectOneLine(state: PillState, where: string): void {
  expect(state.overflow, where).toBeLessThanOrEqual(0);
  expect(state.height, where).toBeLessThan(48);
  expect(state.spare, where).toBeGreaterThanOrEqual(-1);
  expect(state.more, where).toBe(state.level > 0);
}

async function selectFirstPhoto(page: Page): Promise<void> {
  const cell = page.locator('.ovl-grid__cell').first();
  await cell.hover();
  await cell.locator('.ovl-tile__select').click();
  await expect(page.getByTestId('selection-pill')).toContainText('1 selected');
}

test('at 1400 with the sidebar and inspector open, the pill collapses on its content area', async ({ launchOverlook }) => {
  const { app, page } = await launchOverlook({ prefix: 'overlook-e2e-pill-content-', env: { OVERLOOK_SEED: '12' } });
  await setWindow(app, 1400);
  await expect.poll(() => page.evaluate<number>('window.innerWidth')).toBe(1400);
  await selectFirstPhoto(page);
  const wide = await settled(page);
  expectOneLine(wide, 'sidebar only');

  await page.keyboard.press('i');
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  await expect.poll(async () => (await settled(page)).area).toBeLessThan(wide.area);
  const narrow = await settled(page);
  expectOneLine(narrow, 'sidebar and inspector');
  // The window didn't change; only the content area did.
  expect(narrow.level).toBeGreaterThanOrEqual(wide.level);
  expect(narrow.area).toBeLessThan(1400 - 200);
});

test('at 200% zoom on the minimum window the pill stays one line, with count and Clear', async ({ launchOverlook }) => {
  const { app, page } = await launchOverlook({ prefix: 'overlook-e2e-pill-zoom-', env: { OVERLOOK_SEED: '12' } });
  await selectFirstPhoto(page);
  await setWindow(app, 960, 2);
  await expect.poll(async () => Math.abs((await page.evaluate<number>('window.innerWidth')) - 480)).toBeLessThanOrEqual(1);
  const state = await settled(page);
  expectOneLine(state, '200%');
  expect(state.level).toBeGreaterThan(0);
  const pill = page.getByTestId('selection-pill');
  await expect(pill).toContainText('1 selected');
  await expect(pill.getByRole('button', { name: 'Clear selection' })).toBeVisible();
  await expect(pill.getByRole('button', { name: 'More selection actions' })).toBeVisible();
});
