import { expect, test } from './support/app.js';
import type { OverlookApi } from '../../src/shared/ipc/api.js';

test('album reorder: keyboard, collapsed menu, undo, and persistence (#225)', async ({ launchOverlook }) => {
  test.setTimeout(60_000);
  const { page } = await launchOverlook({ prefix: 'overlook-e2e-album-reorder-', env: { OVERLOOK_SEED: '1' } });
  const createAlbum = async (name: string): Promise<void> => {
    await page.getByRole('button', { name: 'New album' }).click();
    await page.getByRole('textbox', { name: 'Album name' }).fill(name);
    await page.getByRole('textbox', { name: 'Album name' }).press('Enter');
    await expect(page.locator('.ovl-sidebar__albumrow', { hasText: name })).toBeVisible();
  };
  const names = (): Promise<string[]> => page.locator('.ovl-sidebar__albumrow .ovl-siderow__label').allTextContents();

  const existing = await names();
  await createAlbum('One');
  await createAlbum('Two');
  await createAlbum('Three');
  const total = existing.length + 3;
  const handle = page.getByRole('button', { name: `Reorder Two, position ${String(total - 1)} of ${String(total)}` });
  await handle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect.poll(names).toEqual([...existing, 'One', 'Three', 'Two']);
  await expect(page.getByTestId('screen-reader-announcer-polite')).toContainText(
    `Two moved to position ${String(total)} of ${String(total)}`,
  );
  await expect(page.getByRole('button', { name: `Reorder Two, position ${String(total)} of ${String(total)}` })).toBeFocused();

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(names).toEqual([...existing, 'One', 'Two', 'Three']);
  await page.reload();
  await expect.poll(names).toEqual([...existing, 'One', 'Two', 'Three']);

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  const collapsed = page.getByRole('button', { name: `Three · 0 · album ${String(total)} of ${String(total)}` });
  await expect(page.getByRole('button', { name: /Reorder Three/u })).toHaveCount(0);
  await collapsed.focus();
  await collapsed.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Move to top' }).click();
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect.poll(names).toEqual(['Three', ...existing, 'One', 'Two']);
});

test('collection drag: collapsed folder, sibling placement, refusal, focus, and persistence (#1104)', async ({ launchOverlook }) => {
  test.setTimeout(120_000);
  const { page } = await launchOverlook({ prefix: 'overlook-e2e-folder-drag-', env: { OVERLOOK_SEED: '1' } });
  const ids = await page.evaluate(async () => {
    const api = (globalThis as unknown as { overlook: OverlookApi }).overlook;
    const source = (await api.albums.create({ name: 'Drag source', kind: 'folder' })).album.id;
    const only = (await api.albums.create({ name: 'Only child', parentId: source })).album.id;
    const destination = (await api.albums.create({ name: 'Drag destination', kind: 'folder' })).album.id;
    const first = (await api.albums.create({ name: 'First child', parentId: destination })).album.id;
    const last = (await api.albums.create({ name: 'Last child', parentId: destination })).album.id;
    const loose = (await api.albums.create({ name: 'Loose album' })).album.id;
    return { source, only, destination, first, last, loose };
  });
  const row = (name: string) => page.locator('.ovl-sidebar__albumrow').filter({ has: page.getByText(name, { exact: true }) });
  const handle = (name: string) => row(name).locator('.ovl-sidebar__album-reorder');
  const drag = async (source: string, target: string, before = false): Promise<void> => {
    const sourceHandle = handle(source);
    await sourceHandle.scrollIntoViewIfNeeded();
    await sourceHandle.focus();
    const sourceBounds = await sourceHandle.boundingBox();
    if (sourceBounds === null) throw new Error('missing drag source');
    const sourceRow = await row(source).boundingBox();
    if (sourceRow === null) throw new Error('missing source row');
    expect(sourceBounds.y).toBeGreaterThanOrEqual(sourceRow.y);
    expect(sourceBounds.y + sourceBounds.height).toBeLessThanOrEqual(sourceRow.y + sourceRow.height);
    const x = sourceBounds.x + sourceBounds.width / 2;
    const y = sourceBounds.y + sourceBounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    try {
      await page.mouse.move(x + 12, y, { steps: 3 });
      await expect(row(source)).toHaveClass(/ovl-sidebar__albumrow--dragging/u);
      const destination = row(target);
      await destination.scrollIntoViewIfNeeded();
      const bounds = await destination.boundingBox();
      if (bounds === null) throw new Error('missing drag destination');
      const targetX = bounds.x + bounds.width / 2;
      const targetY = bounds.y + (before ? 1 : bounds.height / 2);
      await page.mouse.move(targetX, targetY, { steps: 5 });
      // Chromium needs a move after dragenter to deliver dragover before drop.
      await page.mouse.move(targetX + 1, targetY);
      await expect(destination).toHaveClass(/ovl-sidebar__albumrow--drop-allowed/u);
    } finally {
      await page.mouse.up();
    }
  };
  const tree = () =>
    page.evaluate(async () => (await (globalThis as unknown as { overlook: OverlookApi }).overlook.library.albums()).albums);
  const announcement = page.getByTestId('screen-reader-announcer-polite');

  await expect(handle('Only child')).toBeEnabled();
  await row('Drag destination').locator(':scope > .ovl-siderow').click();
  await expect(row('Last child')).toHaveCount(0);
  await drag('Only child', 'Drag destination');
  await expect(announcement).toContainText('Moved Only child to Drag destination.');
  await expect(row('Drag destination').locator(':scope > .ovl-siderow')).toHaveAttribute('aria-expanded', 'true');
  await expect(handle('Only child')).toBeFocused();
  await expect.poll(async () => (await tree()).find((album) => album.id === ids.only)?.parentId).toBe(ids.destination);

  await drag('Loose album', 'Last child', true);
  await expect
    .poll(async () => (await tree()).filter((album) => album.parentId === ids.destination).map((album) => album.id))
    .toEqual([ids.first, ids.loose, ids.last, ids.only]);
  await expect(handle('Loose album')).toBeFocused();

  // A folder can move too, but its ancestor cannot then be dropped into it.
  await drag('Drag source', 'Drag destination');
  await expect(row('Drag source')).toHaveAttribute('data-depth', '1');
  const beforeCycle = await tree();
  await drag('Drag destination', 'Drag source');
  await expect(announcement).toContainText('a folder cannot be moved into itself');
  await expect(handle('Drag destination')).toBeFocused();
  expect(await tree()).toEqual(beforeCycle);

  await page.evaluate(async () => {
    const api = (globalThis as unknown as { overlook: OverlookApi }).overlook;
    let parentId: string | null = null;
    for (let depth = 0; depth <= 6; depth += 1) {
      parentId = (await api.albums.create({ name: `Depth ${depth}`, kind: 'folder', parentId })).album.id;
    }
  });
  const beforeDepth = await tree();
  await drag('Only child', 'Depth 6');
  await expect(announcement).toContainText('albums nest at most 6 levels deep');
  expect(await tree()).toEqual(beforeDepth);
  await expect(handle('Only child')).toBeFocused();
  await page.reload();
  await expect(row('Only child')).toHaveAttribute('data-depth', '1');
  await expect.poll(tree).toEqual(beforeDepth);
});
