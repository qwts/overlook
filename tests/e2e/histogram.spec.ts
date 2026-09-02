import { test, expect } from './support/app.js';

// #498 acceptance over the real app: the Inspector's Histogram section is
// computed in main from the focused photo's own mid derivative, so it is
// ready without blocking the lightbox, follows paging, and tracks the
// persisted edit stack — a saved rotation swaps the measured edges, a saved
// crop shrinks them and moves the bins.
//
// Seed 4: photo 1 (IMG_4028.JPG) is a synced JPEG with a local original.
test('histogram: ready in the Inspector, follows paging, tracks saved edits', async ({ launchOverlook }) => {
  test.setTimeout(90_000);
  const { page } = await launchOverlook({ prefix: 'overlook-e2e-histogram-', env: { OVERLOOK_SEED: '4' } });
  await page.locator('.ovl-tile__img').first().waitFor();
  await page.locator('.ovl-grid__cell').nth(1).click();
  const lightbox = page.getByTestId('lightbox');
  await expect(lightbox).toContainText('IMG_4028.JPG');
  const viewport = page.getByTestId('lightbox-viewport');
  await expect(viewport).toHaveAttribute('data-load-state', 'decoded');

  await page.keyboard.press('i');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const histogram = inspector.getByTestId('inspector-histogram');
  await expect(histogram).toHaveAttribute('data-state', 'ready');
  await expect(histogram.getByRole('img', { name: /^Histogram of IMG_4028\.JPG/u })).toBeVisible();
  await expect(histogram).toContainText('Clipping');
  await expect(histogram).toContainText(/Preview · sRGB · \d+×\d+/u);
  const size = await histogram.getAttribute('data-size');
  const digest = await histogram.getAttribute('data-digest');
  expect(size).toMatch(/^\d+×\d+$/u);
  expect(digest).toMatch(/^[0-9a-f]{8}$/u);
  const width = Number(size?.split('×')[0]);
  const height = Number(size?.split('×')[1]);

  // Paging changes the subject: a different photo, a different histogram.
  await page.keyboard.press('ArrowRight');
  await expect(lightbox).toContainText('IMG_4035.JPG');
  await expect(histogram).toHaveAttribute('data-state', 'ready');
  await expect(histogram).not.toHaveAttribute('data-digest', digest ?? '');
  await page.keyboard.press('ArrowLeft');
  await expect(lightbox).toContainText('IMG_4028.JPG');
  await expect(histogram).toHaveAttribute('data-digest', digest ?? '');

  // A saved rotation re-bakes the derivative: the measured edges swap.
  await page.getByRole('button', { name: /^Rotate clockwise/u }).click();
  await expect(viewport).toHaveAttribute('data-orientation-turns', '1');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(viewport).toHaveAttribute('data-edit-busy', 'false');
  await expect(viewport).toHaveAttribute('data-edit-dirty', 'false');
  await expect(histogram).toHaveAttribute('data-size', `${String(height)}×${String(width)}`);
  await expect(histogram).not.toHaveAttribute('data-revision', '');

  // A saved crop keeps fewer pixels: smaller edges, different bins.
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
  await expect(viewport).not.toHaveAttribute('data-edit-crop', 'none');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(viewport).toHaveAttribute('data-edit-busy', 'false');
  await expect(viewport).toHaveAttribute('data-edit-dirty', 'false');
  await expect
    .poll(async () => {
      const [croppedWidth, croppedHeight] = ((await histogram.getAttribute('data-size')) ?? '0×0').split('×').map(Number);
      return (croppedWidth ?? 0) * (croppedHeight ?? 0);
    })
    .toBeLessThan(width * height);
  await expect(histogram).not.toHaveAttribute('data-digest', digest ?? '');
  await expect(histogram).toHaveAttribute('data-state', 'ready');
});
