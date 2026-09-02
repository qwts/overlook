import { test, expect } from './support/app.js';

// #493 acceptance over the real app: a lightbox rotation and crop saved with
// ⌘S become an immutable revision — the grid tile re-bakes (a derivative-only
// refresh, no reload), the lightbox reopens on the saved transform, the
// Inspector's Edits section describes it, Reset returns to the original, and
// Revert steps back to the previous revision. The ledger dirties like any edit.
//
// Seed 4 (src/main/library/seed.ts): photo 0 is the RAW record (born dirty,
// "Encrypting 1"), photo 1 (IMG_4028.JPG) is a synced JPEG with a local original.
test('persisted edits: save, re-baked tile, reopen, inspector, reset, revert', async ({ launchOverlook }) => {
  test.setTimeout(90_000);
  const { page } = await launchOverlook({ prefix: 'overlook-e2e-photo-edits-', env: { OVERLOOK_SEED: '4' } });
  await page.locator('.ovl-tile__img').first().waitFor();
  await expect(page.getByTestId('sync-state')).toContainText('Encrypting 1 → Local mock');
  const tile = page.locator('.ovl-grid__cell').nth(1);
  const tileImage = tile.locator('.ovl-tile__img');
  const originalSrc = await tileImage.getAttribute('src');
  expect(originalSrc).not.toBeNull();

  await tile.click();
  const lightbox = page.getByTestId('lightbox');
  await expect(lightbox).toContainText('IMG_4028.JPG');
  const viewport = page.getByTestId('lightbox-viewport');
  await expect(viewport).toHaveAttribute('data-load-state', 'decoded');
  await expect(viewport).toHaveAttribute('data-edit-dirty', 'false');
  const save = page.getByTestId('lightbox-edit-save');
  await expect(save).toBeDisabled();

  // Rotate: the draft is dirty and Save arms; nothing is written yet.
  await page.getByRole('button', { name: /^Rotate clockwise/u }).click();
  await expect(viewport).toHaveAttribute('data-orientation-turns', '1');
  await expect(viewport).toHaveAttribute('data-edit-dirty', 'true');
  await expect(save).toBeEnabled();

  // Crop: C opens the drawing surface over the oriented image; a drag frames
  // the left half and Enter applies it.
  await page.keyboard.press('c');
  await expect(viewport).toHaveAttribute('data-edit-mode', 'crop');
  const surface = page.getByTestId('lightbox-crop');
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.9, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('Enter');
  await expect(viewport).toHaveAttribute('data-edit-mode', 'view');
  await expect(viewport).not.toHaveAttribute('data-edit-crop', 'none');

  // ⌘S persists the revision: the draft settles clean, the ledger dirties,
  // and the grid tile re-bakes in place.
  await page.keyboard.press('ControlOrMeta+s');
  await expect(viewport).toHaveAttribute('data-edit-busy', 'false');
  await expect(viewport).toHaveAttribute('data-edit-dirty', 'false');
  await expect(page.getByTestId('sync-state')).toContainText('Encrypting 2 → Local mock');
  await page.keyboard.press('Escape');
  await expect(lightbox).toBeHidden();
  await expect(tileImage).not.toHaveAttribute('src', originalSrc ?? '');

  // Reopen: the saved transform is the starting point, and the Inspector names it.
  await tile.click();
  await expect(viewport).toHaveAttribute('data-load-state', 'decoded');
  await expect(viewport).toHaveAttribute('data-orientation-turns', '1');
  await expect(viewport).not.toHaveAttribute('data-edit-crop', 'none');
  await expect(viewport).toHaveAttribute('data-edit-dirty', 'false');
  await page.keyboard.press('i');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const edits = inspector.getByTestId('inspector-edits');
  await expect(edits).toContainText('Rotated 90°');
  await expect(edits).toContainText('Cropped');
  await expect(edits).toContainText('1');
  await page.keyboard.press('i');

  // Reset writes a new empty revision; Revert steps back to the rotated one.
  await page.getByTestId('lightbox-edit-reset').click();
  await expect(viewport).toHaveAttribute('data-orientation-turns', '0');
  await expect(viewport).toHaveAttribute('data-edit-crop', 'none');
  await expect(viewport).toHaveAttribute('data-edit-busy', 'false');
  await page.keyboard.press('Escape');
  await tile.click();
  await expect(viewport).toHaveAttribute('data-load-state', 'decoded');
  await expect(viewport).toHaveAttribute('data-orientation-turns', '0');
  const revert = page.getByTestId('lightbox-edit-revert');
  await expect(revert).toBeEnabled();
  await revert.click();
  await expect(viewport).toHaveAttribute('data-orientation-turns', '1');
  await expect(viewport).not.toHaveAttribute('data-edit-crop', 'none');
  await page.keyboard.press('i');
  await expect(edits).toContainText('3');
  await expect(edits).toContainText('Rotated 90°');
});
