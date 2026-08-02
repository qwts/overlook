import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import { createExportRuntime } from '../../src/main/export/export-runtime.js';
import type { PhotoRecord } from '../../src/shared/library/types.js';

const PHOTO = {
  id: 'photo-a',
  fileName: 'photo.jpg',
  fileKind: 'jpeg',
  bytes: 1,
  contentHash: 'hash-a',
} as PhotoRecord;

describe('export runtime serialization (#311 review)', () => {
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
    assert.deepEqual(result, { exported: 1, failed: 0, cancelled: 0, previewTranscodes: 0, failures: [] });
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
