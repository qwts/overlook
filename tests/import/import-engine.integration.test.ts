import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { extractMetadata } from '../../src/main/import/exif.js';
import { ImportEngine, type ImportEngineDeps } from '../../src/main/import/import-engine.js';
import { ImportJournal } from '../../src/main/import/import-journal.js';
import { ThumbnailPool } from '../../src/main/import/thumbnail-pool.js';
import { ThumbnailService } from '../../src/main/import/thumbnail-service.js';
import { ulid } from '../../src/main/import/ulid.js';
import type { EnvelopeKey } from '../../src/main/crypto/envelope.js';
import type { PhotoInsert, PhotoRecord } from '../../src/shared/library/types.js';

// #87 exit criteria, real components end to end: real envelope-encrypted
// blob store, real EXIF extraction, real sharp thumbnail pipeline, real
// journal on disk — only the DB is an in-memory fake. Move semantics and
// the E4.6 orphan scan close the loop.

const FIXTURES = join(import.meta.dirname, '../../../tests/fixtures/exif');
const WORKER_URL = new URL('../../src/main/import/thumbnail-worker.js', import.meta.url);

const pool = new ThumbnailPool({ workerUrl: WORKER_URL, size: 2 });
after(async () => {
  await pool.close();
});

describe('import engine integration (#87)', () => {
  test('per-library import journals never resume another library batch (#387)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'overlook-import-library-isolation-'));
    const libraryA = join(root, 'library-a');
    const libraryB = join(root, 'library-b');
    mkdirSync(libraryA);
    mkdirSync(libraryB);
    const journalA = new ImportJournal(join(libraryA, 'import-journal.json'));
    const journalB = new ImportJournal(join(libraryB, 'import-journal.json'));
    await journalA.begin({
      batchId: 'batch-a',
      mode: 'copy',
      source: '/card-a',
      files: [{ path: '/card-a/a.jpg', fileName: 'a.jpg', kind: 'jpeg', stage: 'pending' }],
    });

    assert.equal(await journalB.read(), null, 'library B has no resumable work from A');
    await journalB.begin({
      batchId: 'batch-b',
      mode: 'move',
      source: '/card-b',
      files: [{ path: '/card-b/b.jpg', fileName: 'b.jpg', kind: 'jpeg', stage: 'pending' }],
    });
    assert.equal((await journalA.read())?.batchId, 'batch-a');
    assert.equal((await journalB.read())?.batchId, 'batch-b');
  });

  test('EXIT CRITERIA: fixture card imports (Move), ULID ids, EXIF flows, no orphans, journal cleared', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'overlook-import-'));
    const sourceDir = join(dataDir, 'CARD');
    mkdirSync(sourceDir);
    for (const name of ['exif-full.jpg', 'exif-stripped.jpg', 'sample.raf', 'corrupt.jpg']) {
      copyFileSync(join(FIXTURES, name), join(sourceDir, name));
    }
    const store = new BlobStore({ dataDir });
    await store.init();
    const key: EnvelopeKey = { id: 1, key: randomBytes(32) };
    const journal = new ImportJournal(join(dataDir, 'import-journal.json'));
    const rows = new Map<string, PhotoInsert>();
    const hashes = new Set<string>();

    const deps: ImportEngineDeps = {
      readFile: async (path) => readFile(path),
      deleteFile: async (path) => unlink(path),
      journal,
      repo: {
        hasContentHash: (hash) => hashes.has(hash),
        get: (id) => rows.get(id) as unknown as PhotoRecord | undefined,
        insert: (photo) => {
          if (rows.has(photo.id)) {
            throw new Error('duplicate id');
          }
          rows.set(photo.id, photo);
          hashes.add(photo.contentHash);
        },
        repairGeneratedDimensions: (id, width, height) => {
          const photo = rows.get(id);
          if (photo === undefined || (photo.width > 0 && photo.height > 0)) return false;
          rows.set(id, { ...photo, width, height });
          return true;
        },
        setDimensionStatus: () => false,
        setPreviewFailure: () => false,
      },
      blobs: store,
      generateThumbs: async (request) => new ThumbnailService(pool, store).generateFor(request),
      extractMetadata,
      currentKey: () => key,
      resolveKey: () => key.key,
      newId: ulid,
      now: () => '2026-07-12T00:00:00.000Z',
      events: { copyProgress: () => undefined, thumbProgress: () => undefined },
      sourceExists: existsSync,
      parentIdentity: async (path) => {
        const info = await stat(dirname(path));
        return `${info.dev}:${info.ino}`;
      },
    };

    const files = ['exif-full.jpg', 'exif-stripped.jpg', 'sample.raf', 'corrupt.jpg'].map((name) => ({
      path: join(sourceDir, name),
      fileName: name,
      kind: name.endsWith('.raf') ? ('raw' as const) : ('jpeg' as const),
    }));
    const summary = await new ImportEngine(deps).importFiles(files, 'move', sourceDir);

    // The corrupt file still IMPORTS (metadata-lite, placeholder thumb) —
    // undecodable pixels are not a failed import (E5.3).
    assert.deepEqual(
      { imported: summary.imported, duplicates: summary.duplicates, failed: summary.failed },
      { imported: 4, duplicates: 0, failed: 0 },
    );

    // ULID-shaped ids; EXIF flowed into the record; RAF got its metadata
    // through the embedded preview.
    const all = [...rows.values()];
    assert.ok(all.every((row) => /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(row.id)));
    const jpegRow = all.find((row) => row.fileName === 'exif-full.jpg');
    assert.equal(jpegRow?.camera, 'FUJIFILM X-T5');
    assert.equal(jpegRow?.takenAt, '2026-06-12T12:34:56');
    const strippedRow = all.find((row) => row.fileName === 'exif-stripped.jpg');
    assert.deepEqual({ width: strippedRow?.width, height: strippedRow?.height }, { width: 960, height: 1280 });
    const rafRow = all.find((row) => row.fileName === 'sample.raf');
    assert.equal(rafRow?.camera, 'FUJIFILM X-T5');

    // Move: every source verified-then-deleted.
    for (const file of files) {
      assert.equal(existsSync(file.path), false, `${file.fileName} source removed after verify`);
    }

    // E4.6 orphan scan: no staging leftovers, no unknown blobs.
    const orphans = await store.scanOrphans(hashes);
    assert.deepEqual(orphans, { staged: [], unknown: [] });

    // Journal cleared; derivatives decrypt (spot-check the JPEG's thumb).
    assert.equal(await journal.read(), null);
    const thumbStream = store.getThumbStream(jpegRow?.contentHash ?? '', 'thumb', () => key.key, jpegRow?.id ?? '');
    const first4 = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      thumbStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      thumbStream.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
      thumbStream.on('error', reject);
    });
    assert.equal(first4.toString('ascii', 0, 4), 'RIFF', 'stored thumb decrypts to WebP');

    // And the whole run is idempotent: a fresh scan of the same bytes would
    // dedupe — re-importing the already-imported JPEG is a duplicate.
    const again = await new ImportEngine(deps).importFiles(
      [{ path: join(FIXTURES, 'exif-full.jpg'), fileName: 'exif-full.jpg', kind: 'jpeg' }],
      'copy',
      FIXTURES,
    );
    assert.equal(again.duplicates, 1);
  });

  test('ACCEPTANCE (#548): a transport stream imports as video by signature, not suffix', async () => {
    const videoFixtures = join(import.meta.dirname, '../../../tests/fixtures/video');
    const dataDir = mkdtempSync(join(tmpdir(), 'overlook-import-ts-'));
    const store = new BlobStore({ dataDir });
    await store.init();
    const key: EnvelopeKey = { id: 1, key: randomBytes(32) };
    const journal = new ImportJournal(join(dataDir, 'j.json'));
    const rows = new Map<string, PhotoInsert>();
    const hashes = new Set<string>();
    const deps: ImportEngineDeps = {
      readFile: async (path) => readFile(path),
      deleteFile: async (path) => unlink(path),
      journal,
      repo: {
        hasContentHash: (hash) => hashes.has(hash),
        get: (id) => rows.get(id) as unknown as PhotoRecord | undefined,
        insert: (photo) => {
          rows.set(photo.id, photo);
          hashes.add(photo.contentHash);
        },
        repairGeneratedDimensions: () => false,
        setDimensionStatus: () => false,
        setPreviewFailure: () => false,
      },
      blobs: store,
      generateThumbs: async (request) => new ThumbnailService(pool, store).generateFor(request),
      extractMetadata,
      currentKey: () => key,
      resolveKey: () => key.key,
      newId: ulid,
      now: () => '2026-07-12T00:00:00.000Z',
      events: { copyProgress: () => undefined, thumbProgress: () => undefined },
      sourceExists: existsSync,
      parentIdentity: async (path) => {
        const info = await stat(dirname(path));
        return `${info.dev}:${info.ino}`;
      },
    };

    // The .ts extension hints video; a JPEG carrying a .ts name must classify
    // by content (jpeg). Copy mode keeps the checked-in fixtures intact.
    const summary = await new ImportEngine(deps).importFiles(
      [
        { path: join(videoFixtures, 'supported-h264-aac.ts'), fileName: 'supported-h264-aac.ts', kind: 'video' },
        { path: join(videoFixtures, 'spoofed-jpeg.ts'), fileName: 'spoofed-jpeg.ts', kind: 'video' },
        { path: join(videoFixtures, 'malformed-no-cadence.ts'), fileName: 'malformed-no-cadence.ts', kind: 'video' },
      ],
      'copy',
      videoFixtures,
    );
    // supported → video, spoofed → jpeg; the malformed `.ts` matches no
    // signature and is rejected, leaving no library row (ADR-0026 §2, scenario 6).
    assert.equal(summary.imported, 2);
    assert.equal(summary.failed, 1);
    assert.equal(
      [...rows.values()].some((row) => row.fileName === 'malformed-no-cadence.ts'),
      false,
    );

    const tsRow = [...rows.values()].find((row) => row.fileName === 'supported-h264-aac.ts');
    assert.equal(tsRow?.fileKind, 'video');
    assert.equal(tsRow?.mediaInfo?.container, 'MPEG-TS');
    assert.equal(tsRow?.mediaInfo?.audioPresent, true);
    assert.deepEqual((tsRow?.mediaInfo?.streams ?? []).map((s) => s.codec).sort(), ['AAC', 'H.264']);

    // Signature wins over the suffix: the spoofed .ts is recorded as jpeg,
    // its original name/extension untouched (custody, §4).
    const spoofedRow = [...rows.values()].find((row) => row.fileName === 'spoofed-jpeg.ts');
    assert.equal(spoofedRow?.fileKind, 'jpeg');
    assert.equal(spoofedRow?.mediaInfo, null);
  });
});
