import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, _electron as electron } from '@playwright/test';

import { mkE2eTmpDir } from './support/tmp-dir.js';

// #101: export proven end-to-end in CI — the whole UI path over the real
// engine, with on-disk assertions. OVERLOOK_EXPORT_DESTINATION mocks the OS
// folder picker (E5.10 harness family).

async function launch(destination: string, extraEnv: Record<string, string> = {}) {
  const userData = mkE2eTmpDir('overlook-e2e-export-');
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_SEED: '4',
      OVERLOOK_INSECURE_KEYSTORE: '1',
      OVERLOOK_EXPORT_DESTINATION: destination,
      ...extraEnv,
    },
  });
  const page = await app.firstWindow();
  if (extraEnv['OVERLOOK_SEED'] === '0') {
    await page.getByRole('button', { name: 'Start a new library' }).click();
  }
  // Callers wait for their own start state (a seeded grid vs empty library).
  await page.getByRole('button', { name: 'Import', exact: true }).waitFor();
  return { app, page };
}

function jpegWithMismatchedExifDimensions(source: Buffer, width: number, height: number): Buffer {
  const bytes = Buffer.from(source);
  const exif = bytes.indexOf(Buffer.from('Exif\0\0', 'binary'));
  if (exif < 0) throw new Error('fixture has no EXIF segment');
  const tiff = exif + 6;
  const littleEndian = bytes.toString('ascii', tiff, tiff + 2) === 'II';
  const readU16 = (offset: number): number => (littleEndian ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset));
  const readU32 = (offset: number): number => (littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset));
  const findEntry = (directory: number, tag: number): number => {
    const entries = readU16(directory);
    for (let index = 0; index < entries; index += 1) {
      const entry = directory + 2 + index * 12;
      if (readU16(entry) === tag) return entry;
    }
    throw new Error(`fixture has no EXIF tag ${String(tag)}`);
  };
  const ifd0 = tiff + readU32(tiff + 4);
  const exifIfdPointer = findEntry(ifd0, 0x8769);
  const exifIfd = tiff + readU32(exifIfdPointer + 8);
  const writeDimension = (tag: number, value: number): void => {
    const entry = findEntry(exifIfd, tag);
    const type = readU16(entry + 2);
    if (readU32(entry + 4) !== 1) throw new Error('fixture dimension tag is not scalar');
    if (type === 3) {
      if (littleEndian) bytes.writeUInt16LE(value, entry + 8);
      else bytes.writeUInt16BE(value, entry + 8);
    } else if (type === 4) {
      if (littleEndian) bytes.writeUInt32LE(value, entry + 8);
      else bytes.writeUInt32BE(value, entry + 8);
    } else {
      throw new Error(`unsupported EXIF dimension type ${String(type)}`);
    }
  };
  writeDimension(0xa002, width);
  writeDimension(0xa003, height);
  return bytes;
}

test('select 3 → pill Export → run → 3 byte-faithful decrypted files on disk', async () => {
  const destination = mkE2eTmpDir('overlook-export-dest-');
  const { app, page } = await launch(destination);
  try {
    await page.getByTestId('virtual-grid').waitFor();
    await page.locator('.ovl-tile__img').first().waitFor();
    for (const index of [1, 2, 3]) {
      await page.locator('.ovl-grid__cell').nth(index).getByRole('button', { name: 'Select' }).click();
    }
    await page.getByTestId('selection-pill').getByRole('button', { name: 'Export' }).click();
    await page.getByRole('button', { name: /Choose folder/u }).click();
    await page.getByRole('button', { name: 'Export 3 photos' }).click();
    await expect(page.getByText('3 photos exported and decrypted.')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Done' }).click();

    // On disk: 3 files, PROVEN byte-faithful — each exported file's sha256
    // and size must equal the library row's content hash (the plaintext
    // digest) and byte count (PR #199 review).
    const rows = await page.evaluate<{ fileName: string; contentHash: string; bytes: number }[]>(
      `window.overlook.library.page({ source: 'all', limit: 10 }).then((r) => r.photos.map((p) => ({ fileName: p.fileName, contentHash: p.contentHash, bytes: p.bytes })))`,
    );
    const files = readdirSync(destination).sort();
    expect(files).toEqual(['IMG_4028.JPG', 'IMG_4035.JPG', 'IMG_4042.JPG']);
    for (const name of files) {
      const bytes = readFileSync(join(destination, name));
      const row = rows.find((candidate) => candidate.fileName === name);
      expect(row, `library row for ${name}`).toBeDefined();
      expect(bytes.length).toBe(row?.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(row?.contentHash);
    }
  } finally {
    await app.close();
  }
});

test('full circle: import a real RAF, lightbox-export as JPEG from its preview', async () => {
  const destination = mkE2eTmpDir('overlook-export-dest-');
  const card = join(mkE2eTmpDir('overlook-export-card-'), 'SDCARD');
  mkdirSync(card);
  copyFileSync(join(import.meta.dirname, '../fixtures/exif/sample.raf'), join(card, 'sample.raf'));
  const { app, page } = await launch(destination, { OVERLOOK_SEED: '0', OVERLOOK_IMPORT_SOURCE: card });
  try {
    // Import the RAF (the only photo), then export it as JPEG from the
    // lightbox — the #98 preview policy end to end.
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByRole('button', { name: 'Import 1 photos' }).click();
    await expect(page.getByText('All 1 photos imported and encrypted.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Show in library' }).click();

    await page.locator('.ovl-tile__img').first().waitFor();
    await page.locator('.ovl-grid__cell').first().click();
    await expect(page.getByTestId('lightbox')).toBeVisible();
    await page.getByTestId('lightbox').getByRole('button', { name: 'Export' }).click();
    await expect(page.getByText('1 photo selected')).toBeVisible();
    await page.getByRole('radio', { name: 'Bake', exact: true }).click();
    await page.getByRole('button', { name: /Choose folder/u }).click();
    await page.getByRole('button', { name: 'Export 1 photo', exact: true }).click();

    // Done copy carries the honest preview-capped note; a real .jpg lands.
    await expect(page.getByText('1 photo exported and decrypted. 1 from RAW previews (preview resolution).')).toBeVisible({
      timeout: 20_000,
    });
    expect(readdirSync(destination)).toEqual(['sample.jpg']);
    const bytes = readFileSync(join(destination, 'sample.jpg'));
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(bytes.length).toBeGreaterThan(100); // a real re-encode (the fixture preview is 1×1), not a stub or empty file
  } finally {
    await app.close();
  }
});

test('HEIC import renders oriented previews and Original export remains byte-faithful (#487)', async () => {
  test.skip(process.platform !== 'darwin', 'HEIC preview decode is the macOS ImageIO contract');
  const destination = mkE2eTmpDir('overlook-heic-export-');
  const card = join(mkE2eTmpDir('overlook-heic-card-'), 'SDCARD');
  mkdirSync(card);
  const source = join(import.meta.dirname, '../fixtures/heic/iphone-13-pro.heic');
  copyFileSync(source, join(card, 'iphone-13-pro.heic'));
  const { app, page } = await launch(destination, { OVERLOOK_SEED: '0', OVERLOOK_IMPORT_SOURCE: card });
  try {
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByRole('button', { name: 'Import 1 photos' }).click();
    await expect(page.getByText('All 1 photos imported and encrypted.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Show in library' }).click();

    const tile = page.locator('.ovl-tile__img').first();
    await expect
      .poll(() => tile.evaluate((image) => (image as unknown as { readonly naturalWidth: number }).naturalWidth))
      .toBeGreaterThan(0);
    const row = await page.evaluate<{ width: number; height: number; previewFailure: string | null }>(
      `window.overlook.library.page({ source: 'all', limit: 1 }).then((r) => ({ width: r.photos[0].width, height: r.photos[0].height, previewFailure: r.photos[0].previewFailure }))`,
    );
    expect(row).toEqual({ width: 3024, height: 4032, previewFailure: null });

    await page.getByRole('button', { name: 'Open iphone-13-pro.heic' }).click();
    const image = page.getByTestId('lightbox').getByRole('img', { name: 'iphone-13-pro.heic' });
    await expect.poll(() => image.evaluate((node) => (node as unknown as { readonly naturalHeight: number }).naturalHeight)).toBe(4032);
    await expect(page.getByText('PREVIEW UNAVAILABLE')).toHaveCount(0);

    await page.getByTestId('lightbox').getByRole('button', { name: 'Export' }).click();
    await page.getByRole('radio', { name: 'Original only', exact: true }).click();
    await page.getByRole('button', { name: /Choose folder/u }).click();
    await page.getByRole('button', { name: 'Export 1 photo', exact: true }).click();
    await expect(page.getByText('1 photo exported and decrypted.')).toBeVisible({ timeout: 20_000 });
    expect(readFileSync(join(destination, 'iphone-13-pro.heic'))).toEqual(readFileSync(source));
  } finally {
    await app.close();
  }
});

test('metadata-lite JPEG imports with decoded dimensions, renders, and exports byte-identically (#367)', async () => {
  const destination = mkE2eTmpDir('overlook-export-dest-');
  const card = join(mkE2eTmpDir('overlook-zero-dim-card-'), 'SDCARD');
  mkdirSync(card);
  const source = join(import.meta.dirname, '../fixtures/exif/exif-stripped.jpg');
  copyFileSync(source, join(card, 'exif-stripped.jpg'));
  const { app, page } = await launch(destination, { OVERLOOK_SEED: '0', OVERLOOK_IMPORT_SOURCE: card });
  try {
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByRole('button', { name: 'Import 1 photos' }).click();
    await expect(page.getByText('All 1 photos imported and encrypted.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Show in library' }).click();

    const row = await page.evaluate<{ width: number; height: number }>(
      `window.overlook.library.page({ source: 'all', limit: 1 }).then((r) => ({ width: r.photos[0].width, height: r.photos[0].height }))`,
    );
    expect(row).toEqual({ width: 960, height: 1280 });
    await page.getByRole('button', { name: 'Open exif-stripped.jpg' }).click();
    const viewport = page.getByTestId('lightbox-viewport');
    await expect(viewport).toHaveAttribute('data-image-width', '960');
    await expect(viewport).toHaveAttribute('data-image-height', '1280');
    const bounds = await viewport.getByRole('img', { name: 'exif-stripped.jpg' }).boundingBox();
    expect(bounds?.width ?? 0).toBeGreaterThan(0);
    expect(bounds?.height ?? 0).toBeGreaterThan(0);
    await page.keyboard.press('i');
    await expect(page.getByTestId('inspector')).toContainText('960×1280 · 1.2 MP');

    await page.getByTestId('lightbox').getByRole('button', { name: 'Export' }).click();
    await page.getByRole('radio', { name: 'Original only', exact: true }).click();
    await page.getByRole('button', { name: /Choose folder/u }).click();
    await page.getByRole('button', { name: 'Export 1 photo', exact: true }).click();
    await expect(page.getByText('1 photo exported and decrypted.')).toBeVisible({ timeout: 20_000 });
    expect(readFileSync(join(destination, 'exif-stripped.jpg'))).toEqual(readFileSync(source));
  } finally {
    await app.close();
  }
});

test('EXIF dimension mismatch keeps decoded dimensions and warns in the Inspector (#500)', async () => {
  const destination = mkE2eTmpDir('overlook-mismatch-export-');
  const card = join(mkE2eTmpDir('overlook-mismatch-card-'), 'SDCARD');
  mkdirSync(card);
  const source = join(import.meta.dirname, '../fixtures/exif/exif-full.jpg');
  writeFileSync(join(card, 'mismatched-exif.jpg'), jpegWithMismatchedExifDimensions(readFileSync(source), 640, 480));
  const { app, page } = await launch(destination, { OVERLOOK_SEED: '0', OVERLOOK_IMPORT_SOURCE: card });
  try {
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByRole('button', { name: 'Import 1 photos' }).click();
    await expect(page.getByText('All 1 photos imported and encrypted.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Show in library' }).click();

    const row = await page.evaluate<{ width: number; height: number; dimensionStatus: string }>(
      `window.overlook.library.page({ source: 'all', limit: 1 }).then((r) => ({ width: r.photos[0].width, height: r.photos[0].height, dimensionStatus: r.photos[0].dimensionStatus }))`,
    );
    expect(row).toEqual({ width: 1280, height: 838, dimensionStatus: 'metadata-mismatch' });
    await page.getByRole('button', { name: 'Open mismatched-exif.jpg' }).click();
    await page.keyboard.press('i');
    const inspector = page.getByTestId('inspector');
    await expect(inspector).toContainText('1280×838 · 1.1 MP');
    await expect(inspector).toContainText('DIMENSIONS MISMATCH — POSSIBLY CORRUPT METADATA');
  } finally {
    await app.close();
  }
});
