import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test';

import { mkE2eTmpDir } from './support/tmp-dir.js';

const PASSWORD = 'Correct Horse Battery Staple 42!';

async function invokeMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ BrowserWindow, Menu }, commandId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(commandId);
    if (item?.click === undefined) throw new Error(`menu item unavailable: ${commandId}`);
    Reflect.apply(item.click, item, [
      item,
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0],
      { triggeredByAccelerator: false },
    ]);
  }, id);
}

async function menuState(app: ElectronApplication, id: string): Promise<{ enabled: boolean; checked: boolean }> {
  return app.evaluate(({ Menu }, commandId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(commandId);
    if (item === null || item === undefined) throw new Error(`menu item unavailable: ${commandId}`);
    return { enabled: item.enabled, checked: item.checked };
  }, id);
}

function launch(userData: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_SEED: '3',
      OVERLOOK_INSECURE_KEYSTORE: '1',
      OVERLOOK_APP_LOCK_TEST_ANCHOR: '1',
      OVERLOOK_PCLOUD_ENABLED: '1',
      OVERLOOK_PCLOUD_CLIENT_ID: 'e2e-pcloud-client',
    },
  });
}

test('native menu routes the focused window and revalidates checked, modal, target, and work state (#531)', async () => {
  test.skip(process.platform !== 'darwin', 'the native application menu is macOS-only (ADR-0024 §5, #699)');
  const app = await launch(mkE2eTmpDir('overlook-e2e-application-menu-'));
  try {
    const page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();

    await expect.poll(() => menuState(app, 'app.settings.open')).toMatchObject({ enabled: true });
    await expect.poll(() => menuState(app, 'photo.trash')).toMatchObject({ enabled: false });

    // Activity is reachable only from the Help menu (#690) — never a sidebar row.
    await expect(page.locator('.ovl-sidebar').getByRole('button', { name: 'Activity' })).toHaveCount(0);
    await expect.poll(() => menuState(app, 'help.activity')).toMatchObject({ enabled: true });
    // Opening Activity clears any overlay already mounted — including non-reducer
    // modals like the shortcut sheet — so it never stacks a second focus trap.
    await invokeMenu(app, 'help.shortcuts');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await invokeMenu(app, 'help.activity');
    await expect(page.getByRole('dialog', { name: 'Activity' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Activity' })).toBeHidden();

    await invokeMenu(app, 'app.settings.open.privacy');
    await expect(page.getByTestId('settings-pane')).toHaveAttribute('data-section', 'privacy');
    await invokeMenu(app, 'app.settings.open.storage');
    await expect(page.getByTestId('settings-pane')).toHaveAttribute('data-section', 'storage');
    await invokeMenu(app, 'app.settings.open.storage');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(1);
    await invokeMenu(app, 'app.settings.open');
    await expect(page.getByTestId('settings-pane')).toHaveAttribute('data-section', 'general');
    await page.keyboard.press('Escape');

    await page.locator('.ovl-tile__img').first().waitFor();
    await page.locator('.ovl-grid__cell').first().click();
    await expect(page.getByTestId('lightbox')).toBeVisible();
    await expect(page.getByTestId('lightbox').getByRole('button', { name: 'Favorite' })).toHaveClass(/ovl-icon-button--active/u);
    await expect.poll(() => menuState(app, 'photo.trash')).toMatchObject({ enabled: true });
    await invokeMenu(app, 'photo.favorite.toggle');
    await expect(page.getByTestId('lightbox').getByRole('button', { name: 'Favorite' })).not.toHaveClass(/ovl-icon-button--active/u);

    await invokeMenu(app, 'app.settings.open.privacy');
    await expect(page.getByTestId('lightbox')).toBeHidden();
    await expect(page.getByTestId('settings-pane')).toHaveAttribute('data-section', 'privacy');
    await invokeMenu(app, 'library.source.favorites');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    await expect.poll(() => menuState(app, 'library.source.favorites')).toMatchObject({ checked: true });

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize());
    await invokeMenu(app, 'app.settings.open.transfer');
    await expect(page.getByTestId('settings-pane')).toHaveAttribute('data-section', 'transfer');
  } finally {
    await app.close();
  }
});

test('lock-safe Settings commands wait without exposing content, then open after unlock (#531)', async () => {
  test.skip(process.platform !== 'darwin', 'the native application menu is macOS-only (ADR-0024 §5, #699)');
  const app = await launch(mkE2eTmpDir('overlook-e2e-application-menu-lock-'));
  try {
    const page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    const configuring = page
      .evaluate(`window.overlook.appLock.configure({ password: ${JSON.stringify(PASSWORD)} })`)
      .catch(() => undefined);
    await expect(page.getByTestId('lock-screen')).toBeVisible();
    await configuring;
    await expect.poll(() => menuState(app, 'app.settings.open.privacy')).toMatchObject({ enabled: true });
    await expect.poll(() => menuState(app, 'library.switch')).toMatchObject({ enabled: true });
    await expect.poll(() => menuState(app, 'library.import')).toMatchObject({ enabled: false });

    await invokeMenu(app, 'library.switch');
    await expect(page.getByTestId('library-switcher')).toBeVisible();
    await expect(page.getByTestId('virtual-grid')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await invokeMenu(app, 'app.settings.open.privacy');
    await expect(page.getByTestId('virtual-grid')).toHaveCount(0);
    await page.getByLabel('App password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByTestId('settings-pane')).toHaveAttribute('data-section', 'privacy');
  } finally {
    await app.close();
  }
});

async function topLevelMenuLabels(app: ElectronApplication): Promise<(string | null)[]> {
  return app.evaluate(({ Menu }) => (Menu.getApplicationMenu()?.items ?? []).map((item) => item.label || item.role || null));
}

async function submenuItemIds(app: ElectronApplication, menuLabel: string): Promise<(string | null)[]> {
  return app.evaluate(({ Menu }, label) => {
    const menu = (Menu.getApplicationMenu()?.items ?? []).find((item) => (item.label || item.role) === label);
    return (menu?.submenu?.items ?? []).map((item) => (item.type === 'separator' ? '—' : (item.id ?? item.role ?? null)));
  }, menuLabel);
}

test('macOS application menu is the six-menu design-system spec projected from the registry (#689)', async () => {
  test.skip(process.platform !== 'darwin', 'the six-menu spec is the macOS bar (#689)');
  const app = await launch(mkE2eTmpDir('overlook-e2e-application-menu-spec-'));
  try {
    const page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();

    // Six menus, exact order, no Window menu.
    expect(await topLevelMenuLabels(app)).toEqual(['Overlook', 'File', 'Edit', 'View', 'Photo', 'Help']);

    // File carries Import + Export Selection + the library trio, in order.
    expect(await submenuItemIds(app, 'File')).toEqual([
      'library.import',
      'photo.export',
      '—',
      'library.switch',
      'library.move',
      'library.new',
    ]);

    // Library + sidebar entries are enabled with a library open; Moodboard is a
    // real view (#515) while Feed has no view yet, so it stays disabled.
    for (const id of ['library.move', 'library.new', 'view.sidebar.toggle', 'view.mode.moodboard']) {
      await expect.poll(() => menuState(app, id)).toMatchObject({ enabled: true });
    }
    await expect.poll(() => menuState(app, 'view.mode.feed')).toMatchObject({ enabled: false });
    // Selection-targeted items are disabled until there is a deterministic target.
    for (const id of ['selection.clear', 'photo.export', 'album.membership.add']) {
      await expect.poll(() => menuState(app, id)).toMatchObject({ enabled: false });
    }
    // Grid/List reflect the current view; source radios reflect the route.
    await expect.poll(() => menuState(app, 'view.mode.grid')).toMatchObject({ enabled: true, checked: true });
    await expect.poll(() => menuState(app, 'library.source.all')).toMatchObject({ checked: true });
  } finally {
    await app.close();
  }
});

test('#689 File/View/Photo menu commands drive their shared handlers (parity)', async () => {
  test.skip(process.platform !== 'darwin', 'the six-menu spec is the macOS bar (#689)');
  const app = await launch(mkE2eTmpDir('overlook-e2e-application-menu-parity-'));
  try {
    const page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();

    // View → Toggle Sidebar removes and restores the sidebar nav.
    const sidebar = page.locator('nav.ovl-sidebar');
    await expect(sidebar).toBeVisible();
    await invokeMenu(app, 'view.sidebar.toggle');
    await expect(sidebar).toBeHidden();
    await invokeMenu(app, 'view.sidebar.toggle');
    await expect(sidebar).toBeVisible();

    // Open a photo → Photo → Export… targets it and opens the same Export dialog
    // the lightbox/toolbar Export button opens (ADR-0024 cross-surface parity).
    await page.locator('.ovl-grid__cell').first().click();
    await expect(page.getByTestId('lightbox')).toBeVisible();
    await expect.poll(() => menuState(app, 'photo.export')).toMatchObject({ enabled: true });
    await invokeMenu(app, 'photo.export');
    await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('macOS menu recreates one primary window and delivers the queued route (#531)', async () => {
  test.skip(process.platform !== 'darwin', 'macOS keeps the app alive with no windows');
  const app = await launch(mkE2eTmpDir('overlook-e2e-application-menu-window-'));
  try {
    const page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect.poll(() => app.windows().length).toBe(0);
    await invokeMenu(app, 'app.settings.open.privacy');
    await expect.poll(() => app.windows().length).toBe(1);
    const replacement = app.windows()[0];
    if (replacement === undefined) throw new Error('replacement window missing');
    await expect(replacement.getByTestId('settings-pane')).toHaveAttribute('data-section', 'privacy');
    expect(app.windows()).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test('Windows/Linux draw no native menu and expose Help from the titlebar (#699)', async () => {
  test.skip(process.platform === 'darwin', 'Windows/Linux run frameless with no native menu bar');
  const app = await launch(mkE2eTmpDir('overlook-e2e-application-menu-titlebar-'));
  try {
    const page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    // No native application menu bar on these platforms (ADR-0024 §5).
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu() === null)).toBe(true);

    // The titlebar Help menu carries the two otherwise menu-only commands.
    const help = page.getByRole('button', { name: 'Help' });
    await help.click();
    await expect(page.getByRole('menu', { name: 'Help' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Activity…' }).click();
    await expect(page.getByRole('dialog', { name: 'Activity' })).toBeVisible();
    // The modal Activity dialog covers the titlebar, so the Help button is not
    // reachable while it is open — dismiss it before returning to the button.
    // (Opening a Help command clears any overlay already mounted rather than
    // stacking a duplicate; that dedup is exercised by the macOS suite, #531.)
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Activity' })).toBeHidden();

    // Keyboard-only path: ArrowDown opens the menu on the first item; Enter runs it.
    await help.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menu', { name: 'Help' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(help).toBeFocused();
  } finally {
    await app.close();
  }
});
