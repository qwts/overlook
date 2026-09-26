import { test, expect, _electron as electron } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sampleJpeg } from '../../src/main/library/seed.js';
import type { PhotoRecord } from '../../src/shared/library/types.js';
import { mkE2eTmpDir } from './support/tmp-dir.js';

test('matching-file recovery leaves Unavailable immediately while transient sync errors stay visible (#1101)', async () => {
  const userData = mkE2eTmpDir('overlook-e2e-original-recovery-');
  const source = join(userData, 'recovered.jpg');
  await writeFile(source, sampleJpeg(1));
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_SEED: '3',
      OVERLOOK_INSECURE_KEYSTORE: '1',
      OVERLOOK_SEED_MISSING_ORIGINAL: '1',
      OVERLOOK_RECOVER_ORIGINAL_SOURCE: source,
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'General', exact: true }).click();
    await page.getByRole('switch', { name: 'Show unavailable items in All Photos' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'All Photos 2', exact: true })).toBeVisible();
    await expect(page.locator('[data-quick-action-photo-id="01J8SEEDPHOTO0002"]')).toBeVisible();
    await page.getByRole('button', { name: 'Unavailable 1', exact: true }).click();
    const missing = page.locator('[data-quick-action-photo-id="01J8SEEDPHOTO0001"]');
    await missing.click();
    await page.keyboard.press('i');
    await page.getByRole('complementary', { name: 'Inspector' }).getByRole('button', { name: 'Recover original…', exact: true }).click();
    await expect(missing).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Unavailable', exact: false })).toHaveCount(0);
    await page.getByRole('button', { name: 'All Photos 3', exact: true }).click();
    const result = await page.evaluate<{ photo: PhotoRecord | null }>('window.overlook.library.get({id:"01J8SEEDPHOTO0001"})');
    expect(result.photo?.originalFailure).toBeNull();
    expect(result.photo?.syncState).toBe('local');
    await expect(page.getByTestId('virtual-grid').locator('.ovl-grid__cell')).toHaveCount(3);
  } finally {
    await app.close();
  }
});
