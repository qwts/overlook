import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, _electron as electron } from '@playwright/test';

import { mkE2eTmpDir } from './support/tmp-dir.js';
import type { OverlookApi } from '../../src/shared/ipc/api.js';

/** Recursive file count — the mock provider's remote blob tree. */
function fileCount(dir: string): number {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length;
  } catch {
    return 0;
  }
}

// #120 exit criteria: Move to Trash from grid AND lightbox → Trash →
// restore → back with favorite/status intact. Purge lands with #121.
test('soft delete: grid + lightbox routes, trash restore keeps state intact', async () => {
  const userData = mkE2eTmpDir('overlook-e2e-trash-');
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_SEED: '3',
      OVERLOOK_INSECURE_KEYSTORE: '1',
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    await page.locator('.ovl-tile__img').first().waitFor();

    // Favorite photo 1 so restore can prove state survives the round-trip.
    await page.evaluate(`window.overlook.library.toggleFavorite({ id: '01J8SEEDPHOTO0001' })`);

    // Grid route: select tile 1 → pill Move to Trash → toast + counts move.
    await page.locator('.ovl-grid__cell').nth(1).hover();
    await page.locator('.ovl-tile__select').nth(1).click();
    await page.getByTestId('selection-pill').getByRole('button', { name: 'Move to Trash' }).click();
    await expect(page.locator('.ovl-toast-host')).toContainText('Moved 1 photo to Trash');
    await expect(page.getByRole('button', { name: 'Trash 1' })).toBeVisible();
    await expect(page.locator('.ovl-grid__cell')).toHaveCount(2);

    // Lightbox route: open the first remaining photo, Move to Trash — the row
    // leaves the visible set, which closes the lightbox.
    await page.locator('.ovl-grid__cell').first().click();
    await expect(page.getByTestId('lightbox')).toBeVisible();
    await page.getByTestId('lightbox').getByRole('button', { name: 'Move to Trash' }).click();
    await expect(page.getByTestId('lightbox')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Trash 2' })).toBeVisible();

    // Trash shows both; the pill exposes restore and permanent deletion
    // (#121's purge ceremony — no Export here).
    await page.getByRole('button', { name: 'Trash 2' }).click();
    // Wait for REAL tiles, not placeholder cells — ⌘A reads loaded photos
    // (the #189 cold-start rule applies to source switches too).
    await expect(page.locator('.ovl-tile__img')).toHaveCount(2);
    await page.keyboard.press('ControlOrMeta+a');
    await expect(page.getByTestId('selection-pill')).toContainText('2 selected');
    await expect(page.getByText('Items in Trash are deleted permanently after 30 days.')).toBeVisible();
    await expect(page.getByText('Deletes permanently in 30 days').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restore from Trash' })).toBeVisible();
    await expect(page.getByTestId('selection-pill').getByRole('button', { name: 'Delete permanently…' })).toBeVisible();
    await expect(page.getByTestId('selection-pill').getByRole('button', { name: 'Export' })).toHaveCount(0);

    // The library-scoped setting updates both policy surfaces live. Off keeps
    // manual permanent deletion available; switching to 7 restarts the fuse.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'General' }).click();
    await page.getByRole('radio', { name: 'Off' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Items in Trash are kept until you delete them permanently.')).toBeVisible();
    await expect(page.getByText('Kept until deleted manually').first()).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'General' }).click();
    await page.getByRole('radio', { name: '7 days' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Items in Trash are deleted permanently after 7 days.')).toBeVisible();
    await expect(page.getByText('Deletes permanently in 7 days').first()).toBeVisible();

    // The in-trash lightbox offers no Move to Trash either (PR #218 review) —
    // an already-deleted row's action is Restore, purge is #121.
    await page.locator('.ovl-grid__cell').first().click();
    await expect(page.getByTestId('lightbox')).toBeVisible();
    await expect(page.getByTestId('lightbox').getByRole('button', { name: 'Move to Trash' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('lightbox')).not.toBeVisible();

    // Restore both: favorite came back intact, trash empties.
    await page.getByRole('button', { name: 'Restore from Trash' }).click();
    await expect(page.locator('.ovl-toast-host')).toContainText('Restored 2 photos');
    await page.getByRole('button', { name: /All Photos/u }).click();
    await expect(page.locator('.ovl-grid__cell')).toHaveCount(3);
    const favorite = await page.evaluate<boolean>(
      `window.overlook.library.get({ id: '01J8SEEDPHOTO0001' }).then((r) => r.photo?.favorite ?? false)`,
    );
    expect(favorite).toBe(true);
    await expect(page.getByRole('button', { name: 'Trash 0' })).toBeVisible();
  } finally {
    await app.close();
  }
});

// #121 exit criteria: purge removes all three copies under the mock
// provider — destructive confirm with exact counts and "Delete" language.
test('purge: confirm ceremony removes DB row, local blob, and remote copy', async () => {
  // A full backup precedes the purge — under parallel-suite load 30s is
  // too tight (the earlier backup-spec CI flake was this same class).
  test.setTimeout(60_000);
  const userData = mkE2eTmpDir('overlook-e2e-purge-');
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_SEED: '3',
      OVERLOOK_INSECURE_KEYSTORE: '1',
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    await page.locator('.ovl-tile__img').first().waitFor();

    // Back up, then target a photo whose blob VERIFIABLY reached the
    // remote (seed profiles settle some rows without uploading them).
    await page.getByRole('button', { name: 'Back up' }).click();
    await expect(page.getByTestId('screen-reader-announcer-polite')).toContainText('Backup complete', { timeout: 20_000 });
    await expect(page.getByTestId('sync-state')).toContainText('All backed up', { timeout: 20_000 });
    const remoteBlobs = join(userData, 'mock-remote', 'blobs');
    const photos = await page.evaluate<{ id: string; contentHash: string; fileName: string }[]>(
      `window.overlook.library.page({ source: 'all', limit: 10 }).then((r) => r.photos.map((p) => ({ id: p.id, contentHash: p.contentHash, fileName: p.fileName })))`,
    );
    const remotePath = (hash: string): string => join(remoteBlobs, hash.slice(0, 2), hash);
    const target = photos.find((photo) => existsSync(remotePath(photo.contentHash)));
    expect(target).toBeDefined();
    const before = fileCount(remoteBlobs);
    expect(before).toBeGreaterThan(0);

    await page.evaluate(`window.overlook.library.delete({ photoIds: ['${target?.id ?? ''}'] })`);
    await page.getByRole('button', { name: 'Trash 1' }).click();
    // Gate ⌘A on the TRASH page having actually landed in state — a lone
    // tile can also match a half-decoded previous source under load, and
    // select-all reads state.photos (the "Delete 2 photos" screenshot).
    await expect(page.locator('.ovl-tile__img')).toHaveCount(1);
    await expect(page.locator('.ovl-tile__open').first()).toHaveAccessibleName(new RegExp(`^Open ${target?.fileName ?? ''},`, 'u'));
    await page.keyboard.press('ControlOrMeta+a');
    await expect(page.getByTestId('selection-pill')).toContainText('1 selected');

    // A stale renderer cannot reuse the former public acknowledgement. The
    // production main process separately confirms every well-shaped request.
    const rejectedStaleAuthorization = await page.evaluate<boolean>(
      `window.overlook.library.purge({ photoIds: ['${target?.id ?? ''}'], authorization: 'photos.delete-permanently.v1' }).then(() => false, () => true)`,
    );
    expect(rejectedStaleAuthorization).toBe(true);

    // The ceremony: permanent delete in the pill → exact-count dialog →
    // count → the destructive button.
    await page.getByTestId('selection-pill').getByRole('button', { name: 'Delete permanently…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete 1 photo permanently?' });
    await expect(confirm).toContainText('Cloud deletion failures are recorded and retried');
    await expect(confirm).toContainText('This cannot be undone.');
    await confirm.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page.locator('.ovl-toast-host')).toContainText('Deleted 1 photo permanently');

    // All three copies are gone; the library keeps browsing.
    await expect(page.getByRole('button', { name: 'Trash 0' })).toBeVisible();
    expect(fileCount(remoteBlobs)).toBe(before - 1);
    expect(existsSync(remotePath(target?.contentHash ?? ''))).toBe(false);
    const stillListed = await page.evaluate<boolean>(
      `window.overlook.library.get({ id: '${target?.id ?? ''}' }).then((r) => r.photo !== null)`,
    );
    expect(stillListed).toBe(false);
    await page.getByRole('button', { name: /All Photos/u }).click();
    await expect(page.locator('.ovl-tile__img')).toHaveCount(2);
  } finally {
    await app.close();
  }
});

test('protected Original: ordinary deletion preserves it and Shift+Delete requires fresh password authority', async () => {
  const password = 'correct horse battery staple';
  const userData = mkE2eTmpDir('overlook-e2e-original-delete-');
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_SEED: '2',
      OVERLOOK_INSECURE_KEYSTORE: '1',
      OVERLOOK_APP_LOCK_TEST_ANCHOR: '1',
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    const target = await page.evaluate<{ id: string; fileName: string }>(`window.overlook.library
      .page({ source: 'all', limit: 1 })
      .then((result) => ({ id: result.photos[0].id, fileName: result.photos[0].fileName }))`);
    await page.evaluate(
      (photoId) =>
        (globalThis as unknown as { overlook: OverlookApi }).overlook.library.setOriginal({ photoIds: [photoId], isOriginal: true }),
      target.id,
    );
    await expect(page.getByRole('img', { name: 'Protected Original' })).toBeVisible();

    const configuring = page
      .evaluate(
        (nextPassword) => (globalThis as unknown as { overlook: OverlookApi }).overlook.appLock.configure({ password: nextPassword }),
        password,
      )
      .catch(() => undefined);
    await expect(page.getByTestId('lock-screen')).toBeVisible();
    await configuring;
    await page.getByLabel('App password').fill(password);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByTestId('virtual-grid').waitFor();

    await page.getByRole('button', { name: `Select ${target.fileName}` }).click();
    await page.getByTestId('selection-pill').getByRole('button', { name: 'Move to Trash' }).click();
    await expect(page.locator('.ovl-toast-host')).toContainText('preserved 1 protected Original');
    await expect(page.getByRole('button', { name: `Open ${target.fileName}` })).toBeVisible();

    const search = page.getByRole('searchbox');
    await search.fill('editable shortcut guard');
    await page.keyboard.press('Shift+Delete');
    await expect(page.getByRole('dialog', { name: 'Authenticate Original deletion' })).toHaveCount(0);
    await search.fill('');
    await search.blur();

    await page.keyboard.press('Shift+Delete');
    const authenticate = page.getByRole('dialog', { name: 'Authenticate Original deletion' });
    await authenticate.getByLabel('App password').fill('wrong password');
    await authenticate.getByRole('button', { name: 'Authenticate' }).click();
    await expect(authenticate.getByRole('alert')).toContainText('incorrect');
    await authenticate.getByLabel('App password').fill(password);
    await authenticate.getByRole('button', { name: 'Authenticate' }).click();
    await expect(authenticate.getByRole('alert')).toContainText('Try again in 1 second');
    await page.waitForTimeout(1_100);
    await authenticate.getByRole('button', { name: 'Authenticate' }).click();

    const confirm = page.getByRole('dialog', { name: `Delete ${target.fileName} permanently?` });
    await expect(confirm).toContainText('overrides Original protection');
    await confirm.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page.locator('.ovl-toast-host')).toContainText('Deleted 1 photo permanently');
    await expect(page.getByRole('button', { name: `Open ${target.fileName}` })).toHaveCount(0);
  } finally {
    await app.close();
  }
});
