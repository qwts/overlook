import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import sharp from 'sharp';

import { createExportRuntime } from '../../src/main/export/export-runtime.js';
import type { PhotoRecord } from '../../src/shared/library/types.js';
import type { BoardExportRequest } from '../../src/shared/moodboard/export-contract.js';

const PHOTO = {
  id: 'photo-a',
  fileName: 'photo.jpg',
  fileKind: 'jpeg',
  bytes: 1,
  contentHash: 'hash-a',
} as PhotoRecord;

const BOARD_PHOTO = { ...PHOTO, fileKind: 'png', deletedAt: null } as PhotoRecord;

function boardRequest(destination: string): BoardExportRequest {
  return {
    board: {
      id: 'board-runtime',
      title: 'Runtime board',
      notes: '',
      size: { width: 40, height: 40 },
      background: 'ink',
      placements: [
        {
          id: 'placement-a',
          photoId: BOARD_PHOTO.id,
          x: 0,
          y: 0,
          w: 40,
          h: 40,
          rotation: 0,
          crop: { x: 0, y: 0, w: 1, h: 1 },
          z: 1,
          groupId: null,
        },
      ],
    },
    availability: { 'placement-a': 'available' },
    output: { width: 40, height: 40 },
    colorSpace: 'display-p3',
    destination,
  };
}

function boardRuntime(source: Buffer) {
  return createExportRuntime({
    repo: { get: (id) => (id === BOARD_PHOTO.id ? BOARD_PHOTO : undefined), exportableIds: () => [BOARD_PHOTO.id] },
    blobs: { getStream: () => Readable.from([source]) },
    resolveKey: () => undefined,
    openOriginal: () => Promise.resolve({ stream: Readable.from([source]) }),
    progress: () => undefined,
    pickDestination: () => Promise.resolve(null),
  });
}

describe('export runtime serialization (#311 review)', () => {
  test('runs board composition through the serialized main-process export queue (#696)', async () => {
    const destination = mkdtempSync(join(tmpdir(), 'overlook-board-runtime-'));
    const source = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } })
      .png()
      .toBuffer();
    const runtime = boardRuntime(source);

    const result = await runtime.runBoard(boardRequest(destination));

    assert.equal(result.rendered, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.path, join(destination, 'Runtime board.png'));
    assert.equal(existsSync(result.path ?? ''), true);
    runtime.close();
    await runtime.drain();
  });

  test('Export All resolves the complete scope in the main-process repository (#885)', async () => {
    const destination = mkdtempSync(join(tmpdir(), 'overlook-export-runtime-all-'));
    let scopeReads = 0;
    const runtime = createExportRuntime({
      repo: {
        get: (id) => (id === PHOTO.id ? PHOTO : undefined),
        exportableIds: () => {
          scopeReads += 1;
          return [PHOTO.id];
        },
      },
      blobs: { getStream: () => Readable.from([Buffer.from([1])]) },
      resolveKey: () => undefined,
      openOriginal: () => Promise.resolve({ stream: Readable.from([Buffer.from([1])]) }),
      progress: () => undefined,
      pickDestination: () => Promise.resolve(null),
    });

    const result = await runtime.runAll(destination);
    assert.deepEqual(result, {
      exported: 1,
      failed: 0,
      cancelled: 0,
      previewTranscodes: 0,
      bakedEdits: 0,
      editSidecars: 0,
      failures: [],
    });
    assert.equal(scopeReads, 1);
  });

  test('close rejects an export already queued behind active work', async () => {
    const destination = mkdtempSync(join(tmpdir(), 'overlook-export-runtime-'));
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opens = 0;
    const runtime = createExportRuntime({
      repo: { get: (id) => (id === PHOTO.id ? PHOTO : undefined), exportableIds: () => [PHOTO.id] },
      blobs: { getStream: () => Readable.from([Buffer.from([1])]) },
      resolveKey: () => undefined,
      openOriginal: async () => {
        opens += 1;
        entered?.();
        await gate;
        return { stream: Readable.from([Buffer.from([1])]) };
      },
      progress: () => undefined,
      pickDestination: () => Promise.resolve(null),
    });
    const active = runtime.run([PHOTO.id], destination, 'original');
    await started;
    const queued = runtime.run([PHOTO.id], destination, 'original');

    runtime.close();
    release?.();

    await active;
    await assert.rejects(queued, /export service is closed/u);
    await runtime.drain();
    assert.equal(opens, 1);
  });
});
