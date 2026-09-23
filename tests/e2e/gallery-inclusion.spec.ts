import { test, expect, _electron as electron } from '@playwright/test';
import type { PhotoRecord } from '../../src/shared/library/types.js';
import type { ElectronApplication, Page } from '@playwright/test';

import { mkE2eTmpDir } from './support/tmp-dir.js';

async function launchSeeded(repairCases = false): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkE2eTmpDir('overlook-e2e-inclusion-');
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_SEED: '12',
      OVERLOOK_INSECURE_KEYSTORE: '1',
      ...(repairCases ? { OVERLOOK_E2E: '1', OVERLOOK_SEED_REPAIR_FAILURES: '1' } : {}),
    },
  });
  const page = await app.firstWindow();
  await page.getByTestId('virtual-grid').waitFor();
  await page.locator('.ovl-tile__img').first().waitFor();
  return { app, page };
}

// #512 / ADR-0030 §4 acceptance over the real IPC boundary: RAW is a
// first-class source with an exact count; the All Photos minimum-size rule
// updates the grid, the sidebar count, and the disclosure live; and turning
// it back to None restores every row without touching records.
//
// Seed geometry (src/main/library/seed.ts): 12 live photos, indexes 0/5/10
// are RAW, dimensions cycle 1280×838 (1.07 MP), 960×1280 (1.23 MP),
// 1280×722 (0.92 MP), 960×960 (0.92 MP) — so a 1 MP floor keeps 6 and
// hides 6.
test('RAW source, minimum-size rule, and its disclosure stay truthful live', async () => {
  const { app, page } = await launchSeeded();
  try {
    const grid = page.getByTestId('virtual-grid');
    await page.getByRole('button', { name: 'RAW 3' }).click();
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(3);
    await expect(page.getByRole('heading', { level: 1, name: 'RAW' })).toBeAttached();
    await expect(page.getByRole('button', { name: 'Unavailable', exact: false })).toHaveCount(0);
    await page.getByRole('button', { name: 'All Photos 12' }).click();
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(12);
    await expect(page.getByTestId('inclusion-status')).toHaveCount(0);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'General' }).click();
    const minimumSize = page.getByRole('combobox', { name: 'Minimum size' });
    await expect(minimumSize).toHaveValue('');
    await minimumSize.selectOption('1');
    await page.keyboard.press('Escape');

    await expect(page.getByRole('button', { name: 'All Photos 6' })).toBeVisible();
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(6);
    await expect(page.getByTestId('inclusion-status')).toHaveText('6 photos hidden by All Photos rules');
    await expect(page.getByRole('button', { name: 'RAW 3' })).toBeVisible();
    await expect(page.getByTestId('statusbar-left')).toContainText('12 photos ·');

    // The disclosure leads straight to the rule; None restores every row.
    await page.getByTestId('inclusion-status').click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Minimum size' }).selectOption('');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'All Photos 12' })).toBeVisible();
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(12);
    await expect(page.getByTestId('inclusion-status')).toHaveCount(0);

    // Library data, not profile state: the policy is readable through the
    // library channel and the setting survived the round trip.
    const policy = await page.evaluate<{ policy: { showUnavailable: boolean; minimumMegapixels: number | null } }>(
      'window.overlook.library.galleryPolicy()',
    );
    expect(policy.policy).toEqual({ showUnavailable: true, minimumMegapixels: null });
  } finally {
    await app.close();
  }
});

test('explicit preview and dimension repair leave Unavailable without restarting (#1098)', async () => {
  const { app, page } = await launchSeeded(true);
  try {
    const previewId = '01J8SEEDPHOTO0001';
    const dimensionId = '01J8SEEDPHOTO0002';
    await page.getByRole('button', { name: 'Unavailable 2', exact: true }).click();
    const grid = page.getByTestId('virtual-grid');
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(2);
    const preview = page.locator(`[data-quick-action-photo-id="${previewId}"]`);
    await preview.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Retry repair', exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(1);
    const dimension = page.locator(`[data-quick-action-photo-id="${dimensionId}"]`);
    await dimension.click();
    await page.keyboard.press('i');
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await inspector.getByRole('button', { name: 'Retry repair', exact: true }).click();
    await expect(dimension).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Unavailable', exact: false })).toHaveCount(0);
    await page.getByRole('button', { name: 'All Photos 12', exact: true }).click();
    await expect(grid.locator('.ovl-grid__cell')).toHaveCount(12);
    for (const id of [previewId, dimensionId]) {
      const result = await page.evaluate<{ photo: PhotoRecord | null }>(`window.overlook.library.get(${JSON.stringify({ id })})`);
      expect(result.photo?.previewFailure).toBeNull();
      expect(result.photo?.dimensionStatus).toBe('verified');
    }
  } finally {
    await app.close();
  }
});

test('Inspector reloads a repaired preview while its All Photos selection remains (#1098)', async () => {
  const { app, page } = await launchSeeded(true);
  try {
    const id = '01J8SEEDPHOTO0001';
    const selected = page.locator(`[data-quick-action-photo-id="${id}"]`);
    await selected.click();
    await page.keyboard.press('i');
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    const thumbnail = inspector.locator('.ovl-inspector__thumb');
    const before = await thumbnail.getAttribute('src');
    await inspector.getByRole('button', { name: 'Retry repair', exact: true }).click();
    await expect(inspector.getByRole('button', { name: 'Retry repair', exact: true })).toHaveCount(0);
    await expect(thumbnail).not.toHaveAttribute('src', before ?? '');
    await expect(thumbnail).toHaveAttribute('src', new RegExp(id, 'u'));
    await expect
      .poll(() => thumbnail.evaluate((element) => (element as unknown as { readonly naturalWidth: number }).naturalWidth))
      .toBeGreaterThan(0);
    await expect(selected).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'All Photos' })).toBeAttached();
  } finally {
    await app.close();
  }
});
