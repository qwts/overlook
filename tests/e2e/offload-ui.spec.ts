import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import { test, expect } from './support/app.js';

const PHOTO_ID = '01J8SEEDPHOTO0000';

async function syncState(page: Page): Promise<string> {
  return page.evaluate<string>(`window.overlook.library.get({ id: '${PHOTO_ID}' }).then((result) => result.photo?.syncState ?? '?')`);
}

async function confirmOffload(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Offload originals' });
  await expect(dialog.getByText('1 original')).toBeVisible();
  await expect(dialog.getByText(/Estimated space freed/u)).toBeVisible();
  await dialog.getByRole('button', { name: 'Offload 1' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => syncState(page)).toBe('offloaded');
}

async function prepareBackedUpPhoto(page: Page): Promise<void> {
  const firstCell = page.locator('.ovl-grid__cell').first();
  await firstCell.locator('.ovl-tile__img').waitFor();
  await page.getByRole('button', { name: 'Back up' }).click();
  await expect(page.getByTestId('sync-state')).toContainText('All backed up · now', { timeout: 20_000 });
}

test('selection Offload and Undo complete verified transitions', async ({ launchOverlook }) => {
  test.setTimeout(60_000);
  const { page } = await launchOverlook({
    prefix: 'overlook-e2e-offload-ui-',
    env: { OVERLOOK_SEED: '4' },
  });
  await prepareBackedUpPhoto(page);
  const firstCell = page.locator('.ovl-grid__cell').first();

  // Minimum-width selection layout keeps Offload visible and moves the
  // secondary actions into the keyboard-accessible overflow.
  await page.setViewportSize({ width: 720, height: 640 });
  await firstCell.getByRole('button', { name: 'Select' }).click();
  const pill = page.getByTestId('selection-pill');
  await expect(pill.getByRole('button', { name: 'Offload' })).toBeVisible();
  await expect(pill.getByRole('button', { name: 'More selection actions' })).toBeVisible();
  await expect(pill.getByRole('button', { name: 'Export' })).toBeHidden();

  // Cancel is read-only and preserves the selection.
  await pill.getByRole('button', { name: 'Offload' }).click();
  const dialog = page.getByRole('dialog', { name: 'Offload originals' });
  await expect(dialog.getByText('1 original')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => syncState(page)).toBe('synced');
  await expect(pill).toContainText('1 selected');

  // Selection entry: verified eviction, targeted update, clear-on-success,
  // and Undo's verified download/status restoration.
  await pill.getByRole('button', { name: 'Offload' }).click();
  await confirmOffload(page);
  await expect(pill).toBeHidden();
  await expect(page.locator('.ovl-toast-host')).toContainText('Offloaded 1 · Freed');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => syncState(page)).toBe('synced');
  await expect(page.locator('.ovl-toast-host')).toContainText('Restored 1 original');
});

test('context-menu Offload and Settings restore complete verified transitions', async ({ launchOverlook }) => {
  test.setTimeout(60_000);
  const { page } = await launchOverlook({
    prefix: 'overlook-e2e-offload-settings-',
    env: { OVERLOOK_SEED: '4' },
  });
  await prepareBackedUpPhoto(page);
  const firstCell = page.locator('.ovl-grid__cell').first();
  const pill = page.getByTestId('selection-pill');

  // Context entry executes the same preflight, then Settings restores the
  // selected original and reports the verified result.
  await firstCell.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Offload original…' }).click();
  await confirmOffload(page);
  await expect(pill).toContainText('1 selected');
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByTestId('settings-dialog');
  await expect(settings.getByText(/stored only in your verified cloud backup/u)).toBeVisible();
  await settings.getByRole('button', { name: 'Restore selected (1)' }).click();
  await expect(settings.getByText('1 restored')).toBeVisible();
  await expect.poll(() => syncState(page)).toBe('synced');
  await page.keyboard.press('Escape');
  const notification = page.getByRole('group', { name: 'Notification' });
  await notification.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(notification).toBeHidden();
  await pill.getByRole('button', { name: 'Clear selection' }).click();
});

test('disconnect is blocked by exact custody and emergency removal leaves provider-required recovery', async ({ launchOverlook }) => {
  test.setTimeout(60_000);
  const { page } = await launchOverlook({
    prefix: 'overlook-e2e-custody-disconnect-',
    env: { OVERLOOK_SEED: '4' },
  });
  await prepareBackedUpPhoto(page);
  const firstCell = page.locator('.ovl-grid__cell').first();
  await firstCell.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Offload original…' }).click();
  await confirmOffload(page);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Disconnect provider' }).click();
  const blocked = page.getByRole('dialog', { name: 'Disconnect Local mock?' });
  await expect(blocked).toContainText('1 cloud-only original');
  await expect(blocked.locator('.ovl-settings__disconnectLibraries.mono-data')).toContainText('1 original');
  await expect(blocked).toContainText('Mock account');
  await expect(blocked).not.toContainText('Encrypted data already stored in Local mock is not deleted.');
  await expect(blocked.getByRole('button', { name: 'Restore all originals first' })).toBeEnabled();

  await blocked.getByRole('button', { name: 'Remove authorization anyway…' }).click();
  const emergency = page.getByRole('dialog', { name: 'Remove Local mock authorization anyway?' });
  await expect(emergency).toContainText('Reconnect Local mock as Mock account');
  await emergency.getByRole('button', { name: 'Remove authorization anyway' }).click();

  const required = page.getByRole('status');
  await expect(required).toContainText('Local mock required');
  await expect(required).toContainText('Reconnect Local mock as Mock account');
  await expect(required.locator('.mono-data')).toContainText('1');
  await expect(page.getByTestId('provider-card')).toContainText('Not connected');
});

test('lightbox offload streams temporarily and releases encrypted custody on close', async ({ launchOverlook }) => {
  test.setTimeout(60_000);
  const { page, userData } = await launchOverlook({
    prefix: 'overlook-e2e-offload-stream-',
    env: { OVERLOOK_SEED: '4' },
  });
  await prepareBackedUpPhoto(page);
  const firstCell = page.locator('.ovl-grid__cell').first();

  // Lightbox entry stays open through preflight, then closes after the
  // confirmed offload instead of immediately rehydrating its own photo.
  await page.setViewportSize({ width: 960, height: 640 });
  await firstCell.click();
  const lightbox = page.getByTestId('lightbox');
  await lightbox.getByRole('button', { name: 'Offload original' }).click();
  await expect(lightbox).toBeVisible();
  await confirmOffload(page);
  await expect(lightbox).toBeHidden();

  // Default-on policy streams from verified encrypted temporary custody,
  // keeps the durable ledger offloaded, and clears both encrypted and
  // plaintext caches on close.
  await firstCell.click();
  await expect(lightbox.getByText('Streaming original · re-offloads on close')).toBeVisible();
  await expect(lightbox.getByRole('button', { name: 'Keep downloaded' })).toBeVisible();
  await expect.poll(() => syncState(page)).toBe('offloaded');
  await lightbox.getByRole('button', { name: 'Close (Esc)' }).click();
  await expect
    .poll(() => readdirSync(join(userData, 'library', 'ephemeral')).length, { message: 'close releases encrypted temporary custody' })
    .toBe(0);
});

test('Keep downloaded promotes a streamed original back to durable custody', async ({ launchOverlook }) => {
  test.setTimeout(60_000);
  const { page } = await launchOverlook({
    prefix: 'overlook-e2e-offload-keep-',
    env: { OVERLOOK_SEED: '4' },
  });
  await prepareBackedUpPhoto(page);
  const firstCell = page.locator('.ovl-grid__cell').first();
  await firstCell.click();
  const lightbox = page.getByTestId('lightbox');
  await lightbox.getByRole('button', { name: 'Offload original' }).click();
  await confirmOffload(page);
  await expect(lightbox).toBeHidden();

  // A new view fetches again after close. Explicit promotion verifies and
  // atomically restores durable bytes before the ledger becomes synced.
  await firstCell.click();
  await expect(lightbox.getByText('Streaming original · re-offloads on close')).toBeVisible();
  await lightbox.getByRole('button', { name: 'Keep downloaded' }).click();
  await expect.poll(() => syncState(page)).toBe('synced');
  await lightbox.getByRole('button', { name: 'Close (Esc)' }).click();
});
