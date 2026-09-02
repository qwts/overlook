import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect } from './support/app.js';
import { mkE2eTmpDir } from './support/tmp-dir.js';

// #497 acceptance over the real app (ADR-0031 §6): a saved rotation leaves
// custody in the one mode the user declared. Original + XMP writes the
// byte-identical original beside a sidecar that names the orientation; Bake
// writes a new JPEG whose edges are swapped. Seed 4: photo 1 (IMG_4028.JPG)
// is a synced JPEG with a local original.

/** JPEG frame size from the SOF marker — no decoder needed. */
function jpegDimensions(bytes: Buffer): { readonly width: number; readonly height: number } {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('not a JPEG marker');
    const marker = bytes[offset + 1] ?? 0;
    const length = bytes.readUInt16BE(offset + 2);
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error('no SOF marker');
}

test('edited export: Original + XMP names the rotation beside the original; Bake renders it', async ({ launchOverlook }) => {
  test.setTimeout(120_000);
  const destination = mkE2eTmpDir('overlook-export-edits-dest-');
  const { page } = await launchOverlook({
    prefix: 'overlook-e2e-export-edits-',
    env: { OVERLOOK_SEED: '4', OVERLOOK_EXPORT_DESTINATION: destination },
  });
  await page.locator('.ovl-tile__img').first().waitFor();
  const tile = page.locator('.ovl-grid__cell').nth(1);
  await tile.click();
  const lightbox = page.getByTestId('lightbox');
  await expect(lightbox).toContainText('IMG_4028.JPG');
  const viewport = page.getByTestId('lightbox-viewport');
  await expect(viewport).toHaveAttribute('data-load-state', 'decoded');
  await page.getByRole('button', { name: /^Rotate clockwise/u }).click();
  await expect(viewport).toHaveAttribute('data-orientation-turns', '1');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(viewport).toHaveAttribute('data-edit-busy', 'false');
  await expect(viewport).toHaveAttribute('data-edit-dirty', 'false');

  // Original + XMP: byte-identical original, sidecar with tiff:Orientation 6.
  await lightbox.getByRole('button', { name: 'Export' }).click();
  await expect(page.getByText('1 photo selected')).toBeVisible();
  await page.getByRole('radio', { name: 'Original + XMP', exact: true }).click();
  await expect(page.getByTestId('export-edits-hint')).toContainText('byte-identical original beside an XMP sidecar');
  await page.getByRole('button', { name: /Choose folder/u }).click();
  await page.getByRole('button', { name: 'Export 1 photo', exact: true }).click();
  await expect(page.getByText('1 photo exported and decrypted. 1 edit sidecar written.')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  expect(readdirSync(destination).sort()).toEqual(['IMG_4028.JPG', 'IMG_4028.xmp']);
  const original = readFileSync(join(destination, 'IMG_4028.JPG'));
  const xmp = readFileSync(join(destination, 'IMG_4028.xmp'), 'utf8');
  expect(xmp).toContain('tiff:Orientation="6"');
  expect(xmp).not.toContain('crs:HasCrop');

  // Bake: a new JPEG with the quarter turn rendered — edges swapped, no EXIF.
  await lightbox.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('radio', { name: 'Bake', exact: true }).click();
  await expect(page.getByRole('group', { name: 'JPEG quality' })).toBeVisible();
  await page.getByRole('radio', { name: 'Small · 80' }).click();
  await page.getByRole('button', { name: /Choose folder/u }).click();
  await page.getByRole('button', { name: 'Export 1 photo', exact: true }).click();
  await expect(page.getByText('1 photo exported and decrypted. 1 with edits baked.')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  const baked = readdirSync(destination).filter((name) => /\.jpg$/u.test(name));
  expect(baked).toHaveLength(1);
  const bakedBytes = readFileSync(join(destination, baked[0] ?? ''));
  const source = jpegDimensions(original);
  expect(jpegDimensions(bakedBytes)).toEqual({ width: source.height, height: source.width });
  expect(bakedBytes.includes(Buffer.from('Exif', 'ascii'))).toBe(false);

  // Original only states the omission and writes nothing beside the original.
  await lightbox.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('radio', { name: 'Original only', exact: true }).click();
  await expect(page.getByTestId('export-edits-omitted')).toContainText('1 photo has presentation edits that will not be exported.');
  await expect(page.getByTestId('export-edits-losses')).toHaveCount(0);
});
