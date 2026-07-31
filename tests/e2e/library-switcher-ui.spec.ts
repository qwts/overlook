import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import type { OverlookApi } from '../../src/shared/ipc/api.js';

import { mkE2eTmpDir } from './support/tmp-dir.js';

const APP_PASSWORD = 'Correct Horse Battery Staple 42!';

// #386: the switcher UI end-to-end — create a library in the modal and LAND
// in it, switch back with the keyboard only, and registry-only removal. The
// switch teardown/crash lanes stay in library-switch.spec.ts (#385).

function launch(userData: string, extra: Record<string, string> = {}): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_INSECURE_KEYSTORE: '1',
      ...extra,
    },
  });
}

test('ACCEPTANCE: create a library in the switcher and land in it; keyboard-only switch back shows everything again (#386)', async () => {
  test.setTimeout(90_000);
  const userData = mkE2eTmpDir('overlook-e2e-switcher-ui-');

  const app = await launch(userData, { OVERLOOK_SEED: '3' });
  try {
    let page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();

    // The titlebar trigger names the current library everywhere (#386).
    await expect(page.getByTestId('library-trigger')).toContainText('My Library');

    // Create "Studio" in the modal: name via keyboard, default location,
    // Enter submits the form (keyboard path through the create flow).
    await page.getByTestId('library-trigger').click();
    await expect(page.getByTestId('library-switcher')).toBeVisible();
    await expect(page.getByTestId('library-row-My Library')).toContainText('Open now');
    await page.getByTestId('new-library').click();
    await page.getByTestId('create-name').fill('Studio');
    await page.keyboard.press('Enter');

    // Acceptance 1: landed in the created library — empty grid, correct name.
    page = await app.firstWindow();
    await page.getByTestId('empty-state').waitFor();
    await expect(page.getByTestId('virtual-grid').locator('.ovl-grid__cell')).toHaveCount(0);
    await expect(page.getByTestId('library-trigger')).toContainText('Studio');

    // Acceptance 2 + 4: switch back keyboard-only — open the switcher from
    // the focused trigger, arrow to the seeded library, Enter.
    await page.getByTestId('library-trigger').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('library-switcher')).toBeVisible();
    await expect(page.getByTestId('library-row-My Library')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('library-row-My Library')).toBeFocused();
    await page.keyboard.press('Enter');

    page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    await expect(page.getByTestId('virtual-grid').locator('.ovl-grid__cell')).toHaveCount(3);
    await expect(page.getByTestId('library-trigger')).toContainText('My Library');
  } finally {
    await app.close();
  }
});

test('remove from list is registry-only in the UI: reassurance copy, row gone, files untouched (#386)', async () => {
  test.setTimeout(60_000);
  const userData = mkE2eTmpDir('overlook-e2e-switcher-rm-');

  const app = await launch(userData, { OVERLOOK_SEED: '1' });
  try {
    const page: Page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();

    // Register a second library without switching (IPC create keeps the UI
    // lane focused on the remove flow).
    const secondPath = await page.evaluate(async () => {
      const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
      const { library } = await overlook.libraries.create({ name: 'Scratch', path: null });
      return library.path;
    });

    await page.getByTestId('library-trigger').click();
    await expect(page.getByTestId('library-list')).toContainText('Scratch');
    await page.getByRole('button', { name: 'Remove library from list: Scratch' }).click();
    await expect(page.getByText('The library files stay on disk and can be opened again.')).toBeVisible();
    await page.getByTestId('remove-confirm').click();

    // Back on the list without the row; the directory survives on disk.
    await expect(page.getByTestId('library-list')).not.toContainText('Scratch');
    const survived = await page.evaluate(async (dir) => {
      const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
      const outcome = await overlook.libraries.add({ path: dir });
      return outcome.ok;
    }, secondPath);
    expect(survived, 're-adding the removed directory proves its files were never touched').toBe(true);
    // The modal snapshots its list — reopen to see the re-added entry. An
    // app-managed directory re-registers under its basename (the ULID), so
    // the stable assertion is the path.
    await page.keyboard.press('Escape');
    await page.getByTestId('library-trigger').click();
    await expect(page.getByTestId('library-list')).toContainText(secondPath);
  } finally {
    await app.close();
  }
});

test('app-locked surface can switch away from a closed startup library without exposing management (#847)', async () => {
  test.setTimeout(90_000);
  const userData = mkE2eTmpDir('overlook-e2e-locked-switcher-');
  const app = await launch(userData, { OVERLOOK_SEED: '1', OVERLOOK_APP_LOCK_TEST_ANCHOR: '1' });
  try {
    let page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    const target = await page.evaluate(async () => {
      const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
      return (await overlook.libraries.create({ name: 'Available target', path: null })).library;
    });

    const configuring = page
      .evaluate(`window.overlook.appLock.configure({ password: ${JSON.stringify(APP_PASSWORD)} })`)
      .catch(() => undefined);
    await expect(page.getByTestId('lock-screen')).toBeVisible();
    await configuring;

    await page.getByRole('button', { name: 'Switch Library…' }).click();
    await expect(page.getByTestId('library-switcher')).toBeVisible();
    await expect(page.getByTestId('new-library')).toHaveCount(0);
    await expect(page.getByTestId('add-existing')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Remove library from list:/u })).toHaveCount(0);
    await page.getByTestId('library-row-Available target').click();

    page = await app.firstWindow();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
          return (await overlook.libraries.current()).library.id;
        }),
      )
      .toBe(target.id);
    await expect(page.getByTestId('lock-screen')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('fresh-profile onboarding opens a retained local library without cloud recovery (#479)', async () => {
  test.setTimeout(60_000);
  const originalProfile = mkE2eTmpDir('overlook-e2e-retained-library-');
  const freshProfile = mkE2eTmpDir('overlook-e2e-reinstall-profile-');
  const retainedLibrary = join(originalProfile, 'library');

  const original = await launch(originalProfile, { OVERLOOK_SEED: '3', OVERLOOK_APP_LOCK_TEST_ANCHOR: '1' });
  try {
    const page = await original.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    await expect(page.getByTestId('virtual-grid').locator('.ovl-grid__cell')).toHaveCount(3);
  } finally {
    await original.close();
  }

  const reinstalled = await launch(freshProfile, {
    OVERLOOK_PICK_LIBRARY_DIR: retainedLibrary,
    OVERLOOK_APP_LOCK_TEST_ANCHOR: '1',
  });
  try {
    let page = await reinstalled.firstWindow();
    await expect(page.getByTestId('restore-onboarding')).toBeVisible();
    await page.getByRole('button', { name: 'Open existing library…' }).click();

    page = await reinstalled.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    await expect(page.getByTestId('restore-onboarding')).not.toBeVisible();
    await expect(page.getByTestId('virtual-grid').locator('.ovl-grid__cell')).toHaveCount(3);
    await expect(page.getByTestId('library-trigger')).toContainText('library');
  } finally {
    await reinstalled.close();
  }
});

test('fresh-profile onboarding rebinds app lock before opening a retained protected library (#479)', async () => {
  test.setTimeout(90_000);
  const originalProfile = mkE2eTmpDir('overlook-e2e-retained-locked-library-');
  const freshProfile = mkE2eTmpDir('overlook-e2e-reinstall-locked-profile-');
  const retainedLibrary = join(originalProfile, 'library');

  const original = await launch(originalProfile, {
    OVERLOOK_SEED: '2',
    OVERLOOK_APP_LOCK_TEST_ANCHOR: '1',
  });
  try {
    const page = await original.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Privacy' }).click();
    await page.getByRole('button', { name: 'Set password…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Set app password' });
    await dialog.getByLabel('New password').fill(APP_PASSWORD);
    await dialog.getByLabel('Confirm password').fill(APP_PASSWORD);
    await dialog.getByRole('button', { name: 'Set app password' }).click();
    await expect(page.getByTestId('lock-screen')).toBeVisible();
  } finally {
    await original.close();
  }

  const reinstalled = await launch(freshProfile, {
    OVERLOOK_PICK_LIBRARY_DIR: retainedLibrary,
    OVERLOOK_APP_LOCK_TEST_ANCHOR: '1',
  });
  try {
    let page = await reinstalled.firstWindow();
    await expect(page.getByTestId('restore-onboarding')).toBeVisible();
    // The test adapter is profile-scoped; make the retained library's anchor
    // visible only after the fresh default has initialized. This stands in
    // for the OS credential store's dataDir-scoped anchor surviving reinstall.
    copyFileSync(join(originalProfile, 'app-lock-test-anchor.json'), join(freshProfile, 'app-lock-test-anchor.json'));
    await page.getByRole('button', { name: 'Open existing library…' }).click();

    page = await reinstalled.firstWindow();
    await expect(page.getByTestId('lock-screen')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Library locked' })).toBeVisible();
    await expect(page.getByTestId('restore-onboarding')).toHaveCount(0);
    await page.getByLabel('App password').fill(APP_PASSWORD);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByTestId('virtual-grid').waitFor();
    await expect(page.getByTestId('virtual-grid').locator('.ovl-grid__cell')).toHaveCount(2);
  } finally {
    await reinstalled.close();
  }
});
