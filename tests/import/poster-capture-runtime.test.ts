import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3-multiple-ciphers';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { run } from '../../src/main/db/sql.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { createPosterCaptureRuntime, type PosterCaptureRuntimeOptions } from '../../src/main/import/poster-capture-runtime.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

const DB_KEY = randomBytes(32);
const VIDEO_ID = '01J8RUNTIME00000000000001';

function videoInsert(): PhotoInsert {
  return {
    id: VIDEO_ID,
    fileName: 'clip.ts',
    fileKind: 'video',
    width: 0,
    height: 0,
    bytes: 42_000,
    contentHash: 'hash-runtime',
    camera: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focalLength: null,
    takenAt: null,
    gpsLat: null,
    gpsLon: null,
    place: null,
    importedAt: '2026-07-01T00:00:00.000Z',
    importSource: 'sd-card',
    keyId: 1,
  };
}

function openDb(): Database.Database {
  const db = openLibraryDatabase({ path: join(mkdtempSync(join(tmpdir(), 'overlook-poster-rt-')), 'library.db'), dbKey: DB_KEY });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped-test-key', '2026-07-01T00:00:00.000Z')`);
  new PhotosRepository(db).insert(videoInsert());
  return db;
}

// Minimal wiring deps: createPosterCaptureRuntime only threads these into the
// PosterCaptureService, so a partial mock cast to the option shape exercises the
// exact composition (candidates → capture → store → changed) without Electron.
function runtime(overrides: Partial<PosterCaptureRuntimeOptions>): PosterCaptureRuntimeOptions {
  return {
    db: openDb(),
    blobs: { verifyThumbs: () => Promise.resolve(false) } as unknown as PosterCaptureRuntimeOptions['blobs'],
    blobsReady: Promise.resolve(),
    thumbnails: {
      regenerateFor: () => Promise.resolve({ generated: true, width: 1, height: 1 }),
    } as unknown as PosterCaptureRuntimeOptions['thumbnails'],
    currentKey: () => ({}) as unknown as ReturnType<PosterCaptureRuntimeOptions['currentKey']>,
    resolveKey: (() => Promise.resolve({})) as unknown as PosterCaptureRuntimeOptions['resolveKey'],
    changed: () => undefined,
    captureFrame: () => Promise.resolve(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    ...overrides,
  };
}

describe('createPosterCaptureRuntime (#548, ADR-0026 §6)', () => {
  test('captures the injected frame and stores it as a PNG poster for a local video row', async () => {
    const stored: Array<{ photoId: string; derivativeKey: string; fileKind: string; bytes: Buffer }> = [];
    const changed: string[][] = [];
    let captureCalls = 0;
    const frame = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    const service = createPosterCaptureRuntime(
      runtime({
        thumbnails: {
          regenerateFor: (opts: { photoId: string; derivativeKey: string; fileKind: string; bytes: Buffer }) => {
            stored.push({ photoId: opts.photoId, derivativeKey: opts.derivativeKey, fileKind: opts.fileKind, bytes: opts.bytes });
            return Promise.resolve({ generated: true, width: 1, height: 1 });
          },
        } as unknown as PosterCaptureRuntimeOptions['thumbnails'],
        changed: (ids) => changed.push([...ids]),
        captureFrame: () => {
          captureCalls += 1;
          return Promise.resolve(frame);
        },
      }),
    );

    assert.deepEqual(await service.capture(), { scanned: 1, captured: 1, failed: 0, skipped: 0 });
    assert.equal(captureCalls, 1);
    // The captured frame is stored through the sharp chain AS A PNG (§6),
    // under the row's own derivative key (#496).
    assert.deepEqual(stored, [{ photoId: VIDEO_ID, derivativeKey: 'hash-runtime', fileKind: 'png', bytes: frame }]);
    assert.deepEqual(changed, [[VIDEO_ID]]);
  });

  test('a row that already has a poster is skipped — the offscreen decoder is never invoked', async () => {
    let captureCalls = 0;
    const service = createPosterCaptureRuntime(
      runtime({
        blobs: { verifyThumbs: () => Promise.resolve(true) } as unknown as PosterCaptureRuntimeOptions['blobs'],
        captureFrame: () => {
          captureCalls += 1;
          return Promise.resolve(Buffer.from([1]));
        },
      }),
    );

    assert.deepEqual(await service.capture(), { scanned: 1, captured: 0, failed: 0, skipped: 1 });
    assert.equal(captureCalls, 0);
  });
});
