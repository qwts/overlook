import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, _electron as electron } from '@playwright/test';

import { mkE2eTmpDir } from './support/tmp-dir.js';

// #549 / ADR-0026: common video containers import transactionally through the
// signature-first pipeline. The fixture is a byte-built, structurally valid
// MP4 (H.264 + AAC declared in moov) — the probe records container facts and
// the grid renders the video tile without autoplay; pixel decode is not the
// point of this spec (poster capture degrades to the placeholder honestly).

function ascii4(type: string): number[] {
  return [...type].map((ch) => ch.charCodeAt(0));
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(8 + body.length), ...ascii4(type), ...body];
}

const IDENTITY = [
  ...u32(0x1_0000),
  ...u32(0),
  ...u32(0),
  ...u32(0),
  ...u32(0x1_0000),
  ...u32(0),
  ...u32(0),
  ...u32(0),
  ...u32(0x4000_0000),
];

function track(handler: 'vide' | 'soun', fourcc: string): number[] {
  const tkhd = box('tkhd', [
    ...u32(0),
    ...u32(0),
    ...u32(0),
    ...u32(1),
    ...u32(0),
    ...u32(0),
    ...u32(0),
    ...u32(0),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...IDENTITY,
    ...u32(640 << 16),
    ...u32(360 << 16),
  ]);
  const entry = box(fourcc, [...Array.from({ length: 6 }, () => 0), ...u16(1), ...Array.from({ length: 70 }, () => 0)]);
  const stbl = box('stbl', box('stsd', u32(0), u32(1), entry), box('stts', u32(0), u32(1), u32(90), u32(1000)));
  const mdhd = box('mdhd', u32(0), u32(0), u32(0), u32(30_000), u32(90_000), u16(0x55c4), u16(0));
  const hdlr = box('hdlr', u32(0), u32(0), ascii4(handler), u32(0), u32(0), u32(0), [0]);
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', stbl)));
}

function buildMp4(): Buffer {
  const ftyp = box('ftyp', ascii4('isom'), u32(0x200), ascii4('isom'), ascii4('mp41'));
  const mvhd = box(
    'mvhd',
    u32(0),
    u32(0),
    u32(0),
    u32(1000),
    u32(3000),
    u32(0x1_0000),
    u16(0x0100),
    u16(0),
    u32(0),
    u32(0),
    IDENTITY,
    Array.from({ length: 24 }, () => 0),
    u32(3),
  );
  const moov = box('moov', mvhd, track('vide', 'avc1'), track('soun', 'mp4a'));
  return Buffer.from([...ftyp, ...moov, ...box('mdat', [0, 0, 0, 0])]);
}

test('ACCEPTANCE (#549): an MP4 classifies by content, imports transactionally, and renders a video tile without autoplay', async () => {
  const card = join(mkE2eTmpDir('overlook-e2e-video-card-'), 'SDCARD');
  mkdirSync(card);
  writeFileSync(join(card, 'clip.mp4'), buildMp4());
  // A spoofed suffix: JPEG magic under .mov must never import as video —
  // it classifies by content as a JPEG (signature wins, ADR-0026 §2).
  writeFileSync(join(card, 'spoof.mov'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x00, 0xff, 0xd9]));

  const userData = mkE2eTmpDir('overlook-e2e-video-');
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, OVERLOOK_USER_DATA: userData, OVERLOOK_INSECURE_KEYSTORE: '1', OVERLOOK_IMPORT_SOURCE: card },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Start a new library' }).click();
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByText('2 new ·')).toBeVisible();
    await page.getByRole('button', { name: 'Import 2 photos' }).click();
    await expect(page.getByText('All 2 photos imported and encrypted.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Show in library' }).click();

    // Rows classify by CONTENT: the MP4 records container facts, the spoofed
    // .mov records jpeg.
    const rows = await page.evaluate<{ fileName: string; fileKind: string; container: string | null }[]>(
      `window.overlook.library.page({ source: 'all', limit: 10 }).then((r) => r.photos.map((p) => ({ fileName: p.fileName, fileKind: p.fileKind, container: p.mediaInfo?.container ?? null })))`,
    );
    const clip = rows.find((row) => row.fileName === 'clip.mp4');
    const spoof = rows.find((row) => row.fileName === 'spoof.mov');
    expect(clip).toMatchObject({ fileKind: 'video', container: 'MP4' });
    expect(spoof).toMatchObject({ fileKind: 'jpeg', container: null });

    // The grid renders both tiles; no <video> element exists in the grid
    // (intentional playback only — never autoplay, ADR-0026 §5).
    await expect(page.getByTestId('virtual-grid').locator('.ovl-grid__cell')).toHaveCount(2);
    expect(await page.getByTestId('virtual-grid').locator('video').count()).toBe(0);
  } finally {
    await app.close();
  }
});
