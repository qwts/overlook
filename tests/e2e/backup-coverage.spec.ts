import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import { test, expect } from './support/app.js';

const PHOTO_ID = '01J8SEEDPHOTO0000';

function remoteBlobFiles(userData: string): string[] {
  try {
    return readdirSync(join(userData, 'mock-remote', 'blobs'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function coverage(page: Page): Promise<string> {
  return page.evaluate<string>(`window.overlook.library.get({ id: '${PHOTO_ID}' }).then((result) => result.photo?.coverage ?? '?')`);
}

async function syncState(page: Page): Promise<string> {
  return page.evaluate<string>(`window.overlook.library.get({ id: '${PHOTO_ID}' }).then((result) => result.photo?.syncState ?? '?')`);
}

// #506 / ADR-0033 exit criteria over the mock provider: Keep on this device
// only removes the verified cloud copy through the Tier D confirmation, the
// row is honest everywhere (tile, Inspector, sidebar, Trash), and Back up
// again returns it to the ordinary verified upload.
test('Keep on this device only removes the cloud copy; Back up again restores coverage', async ({ launchOverlook }) => {
  test.setTimeout(90_000);
  const { page, userData } = await launchOverlook({
    prefix: 'overlook-e2e-backup-coverage-',
    env: { OVERLOOK_SEED: '4' },
  });
  const firstCell = page.locator('.ovl-grid__cell').first();
  await firstCell.locator('.ovl-tile__img').waitFor();
  await page.getByRole('button', { name: 'Back up' }).click();
  await expect(page.getByTestId('sync-state')).toContainText('All backed up · now', { timeout: 20_000 });
  await expect.poll(() => remoteBlobFiles(userData).length).toBe(4);

  // Context entry → preflight: a verified copy exists, so the dialog is the
  // irreversible tier and names the provider it will delete from.
  await page
    .getByRole('button', { name: /^Open IMG_/u })
    .first()
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Keep on this device only…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove the cloud copy?' });
  await expect(dialog.getByTestId('coverage-remote')).toContainText('Local mock');
  await dialog.getByRole('button', { name: 'Remove cloud copy permanently' }).click();
  await expect(dialog).toBeHidden();

  // The row is excluded, the provider copy is gone, and the UI says so.
  await expect.poll(() => coverage(page), { timeout: 20_000 }).toBe('excluded');
  await expect.poll(() => remoteBlobFiles(userData).length).toBe(3);
  await expect(page.locator('.ovl-toast-host')).toContainText('kept on this device only');
  await expect(page.getByTestId('storage-excluded')).toBeVisible();
  // ADR-0033 §6: the sync chip never claims "All backed up" over a local-only photo.
  await expect(page.getByTestId('sync-state')).toContainText('Backed up except 1 local-only photo');
  await expect(firstCell.getByLabel('On this device only')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back up' })).toBeHidden();

  // Re-enabling is an ordinary dirty row: the verified upload puts it back.
  await page
    .getByRole('button', { name: /^Open IMG_/u })
    .first()
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Back up again' }).click();
  await expect.poll(() => coverage(page)).toBe('included');
  await expect.poll(() => syncState(page), { timeout: 20_000 }).toBe('synced');
  await expect.poll(() => remoteBlobFiles(userData).length).toBe(4);
  await expect(page.getByTestId('storage-excluded')).toBeHidden();
});
