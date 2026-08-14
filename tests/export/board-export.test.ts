import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, test } from 'node:test';

import sharp from 'sharp';

import { BoardExportCancelledError, exportBoardPng, type BoardExportDeps } from '../../src/main/export/board-export.js';
import type { PhotoRecord } from '../../src/shared/library/types.js';
import { boardExportRequestSchema, type BoardExportRequest } from '../../src/shared/moodboard/export-contract.js';

const PHOTO = {
  id: 'photo-visible',
  fileName: 'visible.png',
  fileKind: 'png',
  deletedAt: null,
} as PhotoRecord;

const REQUEST: BoardExportRequest = boardExportRequestSchema.parse({
  board: {
    id: 'board-1',
    title: 'Color board',
    notes: '',
    size: { width: 100, height: 80 },
    background: 'ink',
    placements: [
      {
        id: 'visible',
        photoId: PHOTO.id,
        x: 10,
        y: 10,
        w: 40,
        h: 40,
        rotation: 0,
        crop: { x: 0.5, y: 0, w: 0.5, h: 1 },
        z: 1,
        groupId: null,
      },
      {
        id: 'locked',
        photoId: 'photo-locked',
        x: 55,
        y: 10,
        w: 40,
        h: 40,
        rotation: 0,
        crop: { x: 0, y: 0, w: 1, h: 1 },
        z: 2,
        groupId: null,
      },
      {
        id: 'missing',
        photoId: 'photo-missing',
        x: 75,
        y: 10,
        w: 40,
        h: 40,
        rotation: 0,
        crop: { x: 0, y: 0, w: 1, h: 1 },
        z: 3,
        groupId: null,
      },
    ],
  },
  availability: { visible: 'available', locked: 'locked', missing: 'unavailable' },
  output: { width: 100, height: 80 },
  colorSpace: 'srgb',
  destination: '/unused',
});

async function halfRedHalfBlue(): Promise<Buffer> {
  const pixels = Buffer.alloc(8 * 4 * 3);
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const offset = (y * 8 + x) * 3;
      pixels[offset] = x < 4 ? 255 : 0;
      pixels[offset + 1] = 0;
      pixels[offset + 2] = x < 4 ? 0 : 255;
    }
  }
  return sharp(pixels, { raw: { width: 8, height: 4, channels: 3 } })
    .png()
    .toBuffer();
}

async function harness(exists: BoardExportDeps['exists'] = () => Promise.resolve(false)): Promise<{
  readonly deps: BoardExportDeps;
  readonly opened: string[];
  readonly writes: string[];
}> {
  const source = await halfRedHalfBlue();
  const opened: string[] = [];
  const writes: string[] = [];
  return {
    opened,
    writes,
    deps: {
      getPhoto: (photoId) => (photoId === PHOTO.id ? PHOTO : undefined),
      openOriginal: (photo) => {
        opened.push(photo.id);
        return Promise.resolve({ stream: Readable.from([source]) });
      },
      writeFile: async (path, stream) => {
        writes.push(path);
        await writeFile(path, await buffer(stream));
      },
      exists,
      freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
      joinPath: (directory, fileName) => join(directory, fileName),
      progress: () => undefined,
    },
  };
}

async function rgbAt(path: string, x: number, y: number): Promise<readonly [number, number, number]> {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0];
}

async function composeRawTaggedJpeg(): Promise<void> {
  const destination = await mkdtemp(join(tmpdir(), 'overlook-board-raw-preview-'));
  const { deps } = await harness();
  const jpeg = await sharp(await halfRedHalfBlue())
    .jpeg()
    .toBuffer();
  const rawMetadata: PhotoRecord = { ...PHOTO, fileName: 'visible.RAF', fileKind: 'raw' };
  const result = await exportBoardPng(
    { ...REQUEST, destination },
    {
      ...deps,
      getPhoto: (photoId) => (photoId === PHOTO.id ? rawMetadata : undefined),
      openOriginal: () => Promise.resolve({ stream: Readable.from([jpeg]) }),
    },
    new AbortController().signal,
  );

  assert.equal(result.rendered, 1);
  assert.equal((await sharp(result.path ?? '').metadata()).format, 'png');
}

describe('moodboard color-managed raster export (#696)', () => {
  test('writes declared geometry with an ICC profile and never opens skipped pixels', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'overlook-board-export-'));
    const { deps, opened } = await harness();
    const result = await exportBoardPng({ ...REQUEST, destination }, deps, new AbortController().signal);

    assert.equal(result.exported, true);
    assert.equal(result.rendered, 1);
    assert.equal(result.skippedLocked, 1);
    assert.equal(result.skippedUnavailable, 1);
    assert.equal(result.skipped, 2);
    assert.deepEqual(opened, [PHOTO.id], 'locked and unavailable originals must never be opened');
    assert.equal(result.path, join(destination, 'Color board.png'));

    const metadata = await sharp(result.path ?? '').metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 100);
    assert.equal(metadata.height, 80);
    assert.ok((metadata.icc?.length ?? 0) > 0, 'the output must carry its declared color profile');

    const croppedPlacement = await rgbAt(result.path ?? '', 20, 20);
    assert.ok(croppedPlacement[2] > 200 && croppedPlacement[0] < 40, `expected the cropped blue half, got ${croppedPlacement.join(',')}`);
    const skippedArea = await rgbAt(result.path ?? '', 60, 20);
    assert.ok(skippedArea[0] < 30 && skippedArea[1] < 30 && skippedArea[2] < 30, `locked area leaked pixels: ${skippedArea.join(',')}`);
  });

  test('embeds distinct sRGB and Display P3 profiles', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'overlook-board-profile-'));
    const first = await harness();
    const srgb = await exportBoardPng({ ...REQUEST, destination }, first.deps, new AbortController().signal);
    const second = await harness();
    const p3 = await exportBoardPng(
      { ...REQUEST, board: { ...REQUEST.board, title: 'P3 board' }, destination, colorSpace: 'display-p3' },
      second.deps,
      new AbortController().signal,
    );
    const srgbProfile = (await sharp(await readFile(srgb.path ?? '')).metadata()).icc;
    const p3Profile = (await sharp(await readFile(p3.path ?? '')).metadata()).icc;
    assert.ok(srgbProfile !== undefined && p3Profile !== undefined);
    assert.notDeepEqual(srgbProfile, p3Profile);
  });

  test('adds a numbered suffix instead of replacing an existing export', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'overlook-board-collision-'));
    const { deps } = await harness((path) => Promise.resolve(path === join(destination, 'Color board.png')));
    const result = await exportBoardPng({ ...REQUEST, destination }, deps, new AbortController().signal);
    assert.equal(result.fileName, 'Color board (2).png');
    assert.equal(result.path, join(destination, 'Color board (2).png'));
  });

  test('composes a valid JPEG payload identified as RAW by library metadata', composeRawTaggedJpeg);

  test('fails corrupt source composition without writing an incomplete board', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'overlook-board-corrupt-'));
    const { deps, writes } = await harness();
    const corrupt: BoardExportDeps = {
      ...deps,
      openOriginal: () => Promise.resolve({ stream: Readable.from([Buffer.from('not an image')]) }),
    };

    await assert.rejects(exportBoardPng({ ...REQUEST, destination }, corrupt, new AbortController().signal));
    assert.deepEqual(writes, []);
  });

  test('an aborted export writes nothing', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'overlook-board-cancel-'));
    const { deps, writes } = await harness();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(exportBoardPng({ ...REQUEST, destination }, deps, controller.signal), BoardExportCancelledError);
    assert.deepEqual(writes, []);
  });
});
