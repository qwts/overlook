import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

import { mkE2eTmpDir } from './support/tmp-dir.js';

const PASSWORD = 'Correct Horse Battery Staple 42!';
const NEXT_PASSWORD = 'Different Excellent Password 73!';

function launch(userData: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_SEED: '2',
      OVERLOOK_INSECURE_KEYSTORE: '1',
      OVERLOOK_APP_LOCK_TEST_ANCHOR: '1',
      OVERLOOK_TOUCH_ID_FAKE: '1',
      OVERLOOK_KEY_EXPORT_DESTINATION: `${userData}/hardened-recovery.key`,
    },
  });
}

async function unlock(page: Page, password: string): Promise<void> {
  await page.getByLabel('App password').fill(password);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.getByTestId('virtual-grid').waitFor();
}

async function emitLifecycleLock(app: ElectronApplication, event: 'lock-screen' | 'suspend' | 'user-did-resign-active'): Promise<void> {
  await app.evaluate(({ powerMonitor }, name) => {
    powerMonitor.emit(name);
  }, event);
}

test('app lock withholds content across configuration, bypass attempts, restart, rotation, and removal', async () => {
  test.setTimeout(60_000);
  const userData = mkE2eTmpDir('overlook-e2e-app-lock-');
  const first = await launch(userData);
  try {
    const page = await first.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    const thumbUrl = await page.locator('.ovl-tile__img').first().getAttribute('src');
    expect(thumbUrl).not.toBeNull();

    await page.locator('.ovl-grid__cell').first().click();
    const inspectorOpened = first.waitForEvent('window');
    await page.keyboard.press('ControlOrMeta+Shift+i');
    const inspectorPage = await inspectorOpened;
    await expect(inspectorPage).toHaveURL(/surface=inspector/u);
    await expect(inspectorPage.getByTestId('inspector')).toContainText('IMG_4021.RAF');
    await page.bringToFront();
    await page.keyboard.press('ArrowRight');
    await expect(inspectorPage.getByTestId('inspector')).toContainText('IMG_4028.JPG');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Privacy' }).click();
    await page.getByRole('button', { name: 'Set password…' }).click();
    const setDialog = page.getByRole('dialog', { name: 'Set app password' });
    await setDialog.getByLabel('New password').fill(PASSWORD);
    await setDialog.getByLabel('Confirm password').fill(PASSWORD);
    await setDialog.getByRole('button', { name: 'Set app password' }).click();

    await expect(page.getByTestId('lock-screen')).toBeVisible();
    await expect(page.getByTestId('virtual-grid')).toHaveCount(0);
    await expect(inspectorPage.getByTestId('lock-screen')).toBeVisible();
    await expect(inspectorPage.getByTestId('inspector')).toHaveCount(0);
    const ipcBypasses = await page.evaluate<string[]>(`(async () => {
      const attempt = async (operation) => {
        try {
          await operation();
          return 'allowed';
        } catch (error) {
          return String(error);
        }
      };
      return Promise.all([
        attempt(() => window.overlook.library.stats()),
        attempt(() => window.overlook.backup.run({})),
        attempt(() =>
          window.overlook.export.pickDestination({ intent: { operation: 'selected', photoIds: ['locked-photo'] } }),
        ),
        attempt(() => window.overlook.settings.get()),
      ]);
    })()`);
    expect(ipcBypasses).toHaveLength(4);
    for (const result of ipcBypasses) expect(result).not.toBe('allowed');
    const cachedThumbBypass = await page.evaluate((url) => {
      const ImageConstructor = (
        globalThis as unknown as {
          Image: new () => { onload: () => void; onerror: () => void; src: string };
        }
      ).Image;
      return new Promise<boolean>((resolve) => {
        const image = new ImageConstructor();
        image.onload = () => resolve(true);
        image.onerror = () => resolve(false);
        image.src = url;
      });
    }, thumbUrl as string);
    expect(cachedThumbBypass).toBe(false);
  } finally {
    await first.close();
  }

  const second = await launch(userData);
  try {
    const page = await second.firstWindow();
    await expect(page.getByTestId('lock-screen')).toBeVisible();
    await expect(page.getByTestId('virtual-grid')).toHaveCount(0);

    await page.getByLabel('App password').fill('wrong password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('status')).toContainText('did not unlock');
    await expect(page.getByRole('button', { name: 'Unlock' })).toBeVisible({ timeout: 3_000 });
    await page.getByLabel('App password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByTestId('virtual-grid').waitFor();

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'General' }).click();
    await page.getByRole('radio', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.keyboard.press('Escape');

    for (const event of ['lock-screen', 'suspend', 'user-did-resign-active'] as const) {
      await emitLifecycleLock(second, event);
      await expect(page.getByTestId('lock-screen')).toBeVisible();
      expect(new URL(page.url()).searchParams.get('theme')).toBe('light');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await unlock(page, PASSWORD);
    }

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Privacy' }).click();
    const hardenedSwitch = page.getByRole('switch', { name: 'Hardened anchor protection' });
    await expect(hardenedSwitch).toBeEnabled();
    await hardenedSwitch.click();
    const backupDialog = page.getByRole('dialog', { name: 'Back up encryption key' });
    await backupDialog.getByLabel('Encrypt backup with password').fill('Recovery Export Password 93!');
    await backupDialog.getByLabel('Confirm password').fill('Recovery Export Password 93!');
    await backupDialog.getByRole('checkbox', { name: 'I understand this password cannot be reset or recovered.' }).check();
    await backupDialog.getByRole('button', { name: 'Export key backup' }).click();
    await expect(backupDialog).toContainText('Key backup saved.');
    await backupDialog.getByRole('button', { name: 'Done' }).click();
    const hardenDialog = page.getByRole('dialog', { name: 'Enable hardened protection' });
    await hardenDialog.getByLabel('Current password').fill(PASSWORD);
    await hardenDialog
      .getByRole('checkbox', {
        name: 'I saved the new recovery-key export and understand that losing it can make this library inaccessible.',
      })
      .check();
    await hardenDialog.getByRole('button', { name: 'Enable hardened protection' }).click();
    await expect(hardenedSwitch).toBeChecked();
    await hardenedSwitch.click();
    const usabilityDialog = page.getByRole('dialog', { name: 'Use automatic anchor repair' });
    await usabilityDialog.getByLabel('Current password').fill(PASSWORD);
    await usabilityDialog.getByRole('button', { name: 'Use automatic anchor repair' }).click();
    await expect(hardenedSwitch).not.toBeChecked();

    const touchIdSwitch = page.getByRole('switch', { name: 'Unlock with Touch ID' });
    await expect(touchIdSwitch).toBeEnabled();
    await expect(touchIdSwitch).not.toBeChecked();
    await touchIdSwitch.click();
    const touchIdDialog = page.getByRole('dialog', { name: 'Enable Touch ID' });
    await touchIdDialog.getByLabel('Current password').fill('wrong password');
    await touchIdDialog.getByRole('button', { name: 'Enable Touch ID' }).click();
    await expect(touchIdDialog.getByRole('status')).toContainText('incorrect');
    await page.waitForTimeout(1200); // The shared failed-attempt gate imposes a one-second backoff.
    await touchIdDialog.getByLabel('Current password').fill(PASSWORD);
    await touchIdDialog.getByRole('button', { name: 'Enable Touch ID' }).click();
    await expect(touchIdDialog).toHaveCount(0);
    await expect(touchIdSwitch).toBeChecked();
    await page.getByRole('button', { name: 'Lock now', exact: true }).last().click();
    await expect(page.getByRole('button', { name: 'Unlock with Touch ID' })).toBeVisible();
    await expect(page.getByLabel('App password')).toBeVisible();
    await page.getByRole('button', { name: 'Unlock with Touch ID' }).click();
    await page.getByTestId('virtual-grid').waitFor();

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Privacy' }).click();
    await expect(page.getByRole('button', { name: 'Import…' })).toBeDisabled();
    await expect(page.getByTestId('recovery-key-row')).toContainText('Remove the app password before importing');
    await page.getByRole('button', { name: 'Change…' }).click();
    const changeDialog = page.getByRole('dialog', { name: 'Change app password' });
    await changeDialog.getByLabel('Current password').fill('wrong password');
    await changeDialog.getByLabel('New password').fill(NEXT_PASSWORD);
    await changeDialog.getByLabel('Confirm password').fill(NEXT_PASSWORD);
    await changeDialog.getByRole('button', { name: 'Change app password' }).click();
    await expect(changeDialog.getByRole('status')).toContainText('incorrect');
    await page.waitForTimeout(1200); // Password changes use the same persisted backoff as unlock.
    await changeDialog.getByLabel('Current password').fill(PASSWORD);
    await changeDialog.getByRole('button', { name: 'Change app password' }).click();
    await expect(changeDialog).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Lock now' }).click();
    await expect(page.getByTestId('lock-screen')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unlock with Touch ID' })).toHaveCount(0);
    await page.getByLabel('App password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('status')).toContainText('did not unlock');
    await expect(page.getByRole('button', { name: 'Unlock' })).toBeVisible({ timeout: 3_000 });
    await page.getByLabel('App password').fill(NEXT_PASSWORD);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByTestId('virtual-grid').waitFor();

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Privacy' }).click();
    await page.getByRole('button', { name: 'Remove…' }).click();
    const removeDialog = page.getByRole('dialog', { name: 'Remove app password' });
    await removeDialog.getByLabel('Current password').fill(NEXT_PASSWORD);
    await removeDialog.getByRole('button', { name: 'Remove app password' }).click();
    await expect(removeDialog).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Lock now' })).toHaveCount(0);
  } finally {
    await second.close();
  }
});
