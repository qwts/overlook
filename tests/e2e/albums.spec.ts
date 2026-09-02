import { test, expect } from './support/app.js';

// #117 exit criteria: create → appears with count 0 → the album filters the
// grid; membership dirties the ledger (pendingCount rises). The full
// album + delete/restore journey is #122's spec.
test('albums: inline create, live counts, album-as-source grid filter', async ({ launchOverlook }) => {
  // Budget contract (#630): staged launch (≤30s) + two backup completions
  // (bounded 20s each) + interaction slack. The 30s config default is
  // structurally below this journey's bounded-wait sum.
  test.setTimeout(60_000);
  const { page } = await launchOverlook({ prefix: 'overlook-e2e-albums-', env: { OVERLOOK_SEED: '3' } });
  await page.locator('.ovl-tile__img').first().waitFor();

  // Back up first so the ledger-dirtying below is unambiguous.
  await page.getByRole('button', { name: 'Back up' }).click();
  await expect(page.getByTestId('sync-state')).toContainText('All backed up', { timeout: 20_000 });

  // Inline create from the sidebar's + affordance.
  await page.getByRole('button', { name: 'New album' }).click();
  await page.getByRole('textbox', { name: 'Album name' }).fill('Kyoto trip');
  await page.getByRole('textbox', { name: 'Album name' }).press('Enter');
  const albumRow = page.locator('.ovl-sidebar__albumrow', { hasText: 'Kyoto trip' }).locator(':scope > .ovl-siderow');
  await expect(albumRow).toContainText('0');

  // Membership over IPC (the selection pill lands with #118): the count
  // goes live and the ledger dirties — amber returns with exact counts.
  const added = await page.evaluate<{ added: number }>(
    `window.overlook.library.albums().then(({ albums }) => {
      const album = albums.find((a) => a.name === 'Kyoto trip');
      return window.overlook.albums.addPhotos({ albumId: album.id, photoIds: ['01J8SEEDPHOTO0001', '01J8SEEDPHOTO0002'] });
    })`,
  );
  expect(added.added).toBe(2);
  await expect(albumRow).toContainText('2');
  await expect(page.getByTestId('sync-state')).toContainText('Encrypting 2 → Local mock');

  // Album as active source: the grid narrows to the two members.
  await albumRow.click();
  await expect(page.locator('.ovl-grid__cell')).toHaveCount(2);
  // Back to All Photos: the album deactivates and the full set returns.
  await page.getByRole('button', { name: /All Photos/u }).click();
  await expect(page.locator('.ovl-grid__cell')).toHaveCount(3);

  // #118: select → Add to album via the pill picker → exact-count toast
  // → the album count bumps → the album source shows the addition.
  await expect(page.locator('.ovl-tile__img')).toHaveCount(3);
  await page.locator('.ovl-grid__cell').first().hover();
  await page.locator('.ovl-tile__select').first().click();
  await page.getByRole('button', { name: 'Add to album' }).click();
  await page
    .getByTestId('album-picker')
    .getByRole('menuitem', { name: /Kyoto trip/u })
    .click();
  await expect(page.locator('.ovl-toast-host')).toContainText('Added 1 photo to Kyoto trip');
  await expect(albumRow).toContainText('3');
  await albumRow.click();
  await expect(page.locator('.ovl-grid__cell')).toHaveCount(3);
});

// #282 exit criteria: every album mutation is reachable without private
// APIs; membership removal never becomes photo deletion; active album and
// keyboard focus have deterministic fallbacks.
test('album management: rename, delete, remove membership, and collapsed keyboard actions', async ({ launchOverlook }) => {
  // Budget contract (#630): staged launch (≤30s) + three backup completions
  // (bounded 20s each) + a long mutation journey. This test repeatedly hit
  // the 30s default exactly because its bounded-wait sum exceeds it.
  test.setTimeout(120_000);
  const { page } = await launchOverlook({ prefix: 'overlook-e2e-album-management-', env: { OVERLOOK_SEED: '4' } });
  await page.locator('.ovl-tile__img').first().waitFor();
  await page.evaluate('window.overlook.settings.set({ patch: { autoBackupOnImport: false } })');

  const createAlbum = async (name: string): Promise<void> => {
    await page.getByRole('button', { name: 'New album' }).click();
    await page.getByRole('textbox', { name: 'Album name' }).fill(name);
    await page.getByRole('textbox', { name: 'Album name' }).press('Enter');
    await expect(page.locator('.ovl-sidebar__albumrow', { hasText: name })).toBeVisible();
  };
  const albumRow = (name: string) => page.locator('.ovl-sidebar__albumrow', { hasText: name });
  const albumButton = (name: string) => albumRow(name).locator(':scope > .ovl-siderow');
  const openAlbumActions = async (name: string): Promise<void> => {
    await albumRow(name).hover();
    await page.getByRole('button', { name: `Actions for ${name}` }).click();
  };

  await createAlbum('Road trip');
  await createAlbum('Empty delete');

  // Empty deletion has explicit, non-destructive language and leaves all
  // four library photos in place.
  await openAlbumActions('Empty delete');
  await page.getByRole('menuitem', { name: 'Delete album…' }).click();
  const emptyDelete = page.getByRole('dialog', { name: 'Delete album' });
  await expect(emptyDelete).toContainText(
    'Photos stay in the library; only the album and its membership are removed. All 0 photos stay in your library.',
  );
  await emptyDelete.getByRole('button', { name: 'Delete album' }).click();
  await expect(page.locator('.ovl-toast-host')).toContainText('Deleted Empty delete · 0 photos kept');
  await expect(albumRow('Empty delete')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /All Photos/u })).toBeFocused();
  await expect(page.locator('.ovl-grid__cell')).toHaveCount(4);

  // Give the populated album all four photos, then establish a clean
  // backup baseline so each later membership edit has an exact pending
  // count.
  const added = await page.evaluate<{ added: number }>(
    `window.overlook.library.albums().then(({ albums }) => {
      const album = albums.find((candidate) => candidate.name === 'Road trip');
      return window.overlook.albums.addPhotos({
        albumId: album.id,
        photoIds: ['01J8SEEDPHOTO0000', '01J8SEEDPHOTO0001', '01J8SEEDPHOTO0002', '01J8SEEDPHOTO0003']
      });
    })`,
  );
  expect(added.added).toBe(4);
  await expect(albumRow('Road trip')).toContainText('4');
  await page.getByRole('button', { name: 'Back up' }).click();
  await expect(page.getByTestId('sync-state')).toContainText('All backed up', { timeout: 20_000 });

  // Rename cancellation restores focus to its opener and changes neither
  // the active filter nor the album name.
  await albumButton('Road trip').click();
  await expect(page.locator('.ovl-grid__cell')).toHaveCount(4);
  await openAlbumActions('Road trip');
  await page.getByRole('menuitem', { name: 'Rename album…' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename album' });
  await rename.getByRole('textbox', { name: 'Album name' }).fill('Do not keep');
  await rename.getByRole('button', { name: 'Cancel' }).click();
  await expect(rename).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Actions for Road trip' })).toBeFocused();
  await expect(albumRow('Road trip')).toHaveClass(/ovl-sidebar__albumrow/u);

  // The committed name is trimmed. The same album remains active and its
  // membership view remains intact.
  await page.getByRole('button', { name: 'Actions for Road trip' }).click();
  await page.getByRole('menuitem', { name: 'Rename album…' }).click();
  await page.getByRole('dialog', { name: 'Rename album' }).getByRole('textbox', { name: 'Album name' }).fill('  Road selects  ');
  await page.getByRole('dialog', { name: 'Rename album' }).getByRole('button', { name: 'Rename' }).click();
  await expect(page.locator('.ovl-toast-host')).toContainText('Renamed album to Road selects');
  const roadRow = albumRow('Road selects');
  await expect(albumButton('Road selects')).toHaveClass(/ovl-siderow--active/u);
  await expect(page.locator('.ovl-grid__cell')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Actions for Road selects' })).toBeFocused();
  await expect(page.getByTestId('sync-state')).toContainText('Encrypting 4 → Local mock');
  await page.getByRole('button', { name: 'Back up' }).click();
  await expect(page.getByTestId('sync-state')).toContainText('All backed up', { timeout: 20_000 });

  // Active-album selection uses neutral membership language. It removes
  // one row and clears its selection without touching Trash.
  const firstCell = page.locator('.ovl-grid__cell').first();
  await firstCell.hover();
  await firstCell.locator('.ovl-tile__select').click();
  const pill = page.getByTestId('selection-pill');
  await expect(pill.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await pill.getByRole('button', { name: 'Remove from album' }).click();
  await expect(page.locator('.ovl-toast-host')).toContainText('Removed 1 photo from Road selects');
  await expect(page.locator('.ovl-grid__cell')).toHaveCount(3);
  await expect(roadRow).toContainText('3');
  await expect(pill).toHaveCount(0);
  await expect(page.getByTestId('sync-state')).toContainText('Encrypting 1 → Local mock');
  await expect(page.getByRole('button', { name: /Trash/u })).toContainText('0');

  await page.getByRole('button', { name: 'Back up' }).click();
  await expect(page.getByTestId('sync-state')).toContainText('All backed up', { timeout: 20_000 });

  // Multi-selection removal reports the exact count and leaves one photo
  // in the album for the populated-delete case below.
  for (let index = 0; index < 2; index += 1) {
    const cell = page.locator('.ovl-grid__cell').nth(index);
    await cell.hover();
    await cell.locator('.ovl-tile__select').click();
  }
  await expect(pill).toContainText('2 selected');
  await pill.getByRole('button', { name: 'Remove from album' }).click();
  await expect(page.locator('.ovl-toast-host')).toContainText('Removed 2 photos from Road selects');
  await expect(page.locator('.ovl-grid__cell')).toHaveCount(1);
  await expect(roadRow).toContainText('1');
  await expect(pill).toHaveCount(0);
  await expect(page.getByTestId('sync-state')).toContainText('Encrypting 2 → Local mock');

  // Deleting the active populated album removes memberships only, returns
  // to All Photos, restores stable focus, and keeps all four originals.
  await openAlbumActions('Road selects');
  await page.getByRole('menuitem', { name: 'Delete album…' }).click();
  const populatedDelete = page.getByRole('dialog', { name: 'Delete album' });
  await expect(populatedDelete).toContainText(
    'Photos stay in the library; only the album and its membership are removed. All 1 photo stays in your library.',
  );
  await populatedDelete.getByRole('button', { name: 'Delete album' }).click();
  await expect(page.locator('.ovl-toast-host')).toContainText('Deleted Road selects · 1 photo kept');
  const allPhotos = page.getByRole('button', { name: /All Photos/u });
  await expect(allPhotos).toHaveClass(/ovl-siderow--active/u);
  await expect(allPhotos).toBeFocused();
  await expect(page.locator('.ovl-grid__cell')).toHaveCount(4);
  await expect(roadRow).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Trash/u })).toContainText('0');
  const libraryStats = await page.evaluate<{ photos: number }>('window.overlook.library.stats()');
  expect(libraryStats.photos).toBe(4);

  // Rail mode retains the context-menu keyboard gesture and arrow-key
  // navigation. Escape closes and restores focus to the icon-only row
  // without leaking to the global selection-clear shortcut.
  await createAlbum('Keyboard album');
  const selectedCell = page.locator('.ovl-grid__cell').first();
  await selectedCell.hover();
  await selectedCell.locator('.ovl-tile__select').click();
  await expect(pill).toContainText('1 selected');
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  const collapsedAlbum = page.getByRole('button', { name: /^Keyboard album · 0 · album \d+ of \d+$/u });
  await collapsedAlbum.focus();
  await collapsedAlbum.press('Shift+F10');
  const keyboardMenu = page.getByRole('menu', { name: 'Actions for Keyboard album' });
  await expect(keyboardMenu.getByRole('menuitem', { name: 'Move up' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  // The middle of the menu grows with folders, tags, and visibility (#505,
  // #494); End and ArrowUp reach Rename without counting those rows.
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  await expect(keyboardMenu.getByRole('menuitem', { name: 'Rename album…' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(keyboardMenu.getByRole('menuitem', { name: 'Delete album…' })).toBeFocused();
  await expect(keyboardMenu.getByRole('menuitem', { name: 'Transfer & Sync…' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(keyboardMenu).toHaveCount(0);
  await expect(collapsedAlbum).toBeFocused();
  await expect(pill).toContainText('1 selected');
});
