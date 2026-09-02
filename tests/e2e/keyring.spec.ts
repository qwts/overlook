import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, _electron as electron } from '@playwright/test';

import { mkE2eTmpDir } from './support/tmp-dir.js';

// #517 exit criteria over the real app: Settings ▸ Privacy lists the
// keyring; a retired key that still seals photos exports to a
// password-sealed key file, its removal is the Tier D ceremony (counts,
// acknowledgment, "permanently"), the photos it sealed turn into locked
// tiles, and importing the file back — wrong password first — unlocks them.
// OVERLOOK_SEED_RETIRED_KEY_FROM=2 seals photos 2 and 3 under KEY #2 and
// retires it, so KEY #3 is the write key from launch.

const PASSWORD = 'Correct Horse Battery 9!';

test('keyring: export, Tier D removal locks the photos, import unlocks them', async () => {
  test.setTimeout(150_000); // three scrypt derivations (~1s each) on top of the app launch
  const userData = mkE2eTmpDir('overlook-e2e-keyring-');
  const keyFile = join(mkE2eTmpDir('overlook-e2e-keyring-file-'), 'overlook-key.key');
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_INSECURE_KEYSTORE: '1',
      OVERLOOK_SEED: '4',
      OVERLOOK_SEED_RETIRED_KEY_FROM: '2',
      OVERLOOK_KEY_EXPORT_DESTINATION: keyFile,
      OVERLOOK_KEY_IMPORT_SOURCE: keyFile,
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    await expect(page.locator('.ovl-tile--locked')).toHaveCount(0);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Privacy' }).click();
    const row = page.getByTestId('keyring-row-2');
    await expect(row).toContainText('Retired');
    await expect(row).toContainText('2 photos');
    await expect(page.getByTestId('keyring-row-1')).toContainText('Database');
    await expect(page.getByTestId('keyring-row-3')).toContainText('Write key');
    await expect(page.getByTestId('keyring-remove-1')).toBeDisabled();
    await expect(page.getByTestId('keyring-remove-3')).toBeDisabled();

    // Export KEY #2 to a password-sealed key file.
    await page.getByTestId('keyring-export-2').click();
    await page.getByLabel('Encrypt key file with password').fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByText('I understand this password cannot be reset or recovered.').click();
    await page.getByTestId('keyring-dialog-export').click();
    await expect(page.getByTestId('keyring-done')).toContainText('Key file saved', { timeout: 30_000 });
    expect(existsSync(keyFile)).toBe(true);
    expect(readFileSync(keyFile).length).toBe(100);
    await page.getByTestId('keyring-dialog-done').click();

    // Remove it: Tier D, with the counts of what turns locked.
    await page.getByTestId('keyring-remove-2').click();
    await expect(page.getByRole('dialog', { name: 'Remove this key?' })).toBeVisible();
    await expect(page.getByTestId('keyring-remove-counts')).toContainText('2');
    const confirm = page.getByRole('button', { name: 'Remove key permanently' });
    await expect(confirm).toBeDisabled();
    await page.getByText('I have an exported copy of this key').click();
    await confirm.click();
    await expect(page.getByTestId('keyring-done')).toContainText('KEY #2 removed · 2 photos locked');
    await page.getByTestId('keyring-dialog-done').click();
    await expect(page.getByTestId('keyring-row-2')).toContainText('Not on this device');
    await page.keyboard.press('Escape');
    await expect(page.locator('.ovl-tile--locked')).toHaveCount(2);
    await expect(page.getByRole('img', { name: 'Locked — this device lacks its encryption key' })).toHaveCount(2);

    // Import it back: the wrong password fails safely on the designed copy first.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Privacy' }).click();
    await page.getByTestId('keyring-import').click();
    await page.getByTestId('keyring-choose-file').click();
    await expect(page.getByTestId('keyring-choose-file')).toContainText('overlook-key.key');
    await page.getByLabel('Password', { exact: true }).fill('not the password');
    await page.getByTestId('keyring-dialog-import').click();
    await expect(page.getByRole('alert')).toContainText('Wrong password', { timeout: 30_000 });
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByTestId('keyring-dialog-import').click();
    await expect(page.getByTestId('keyring-done')).toContainText('KEY #2 imported · 2 photos unlocked', { timeout: 30_000 });
    await page.getByTestId('keyring-dialog-done').click();
    await expect(page.getByTestId('keyring-row-2')).toContainText('Imported');
    await page.keyboard.press('Escape');
    await expect(page.locator('.ovl-tile--locked')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
