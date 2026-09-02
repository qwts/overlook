import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import sharp from 'sharp';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { ThumbnailPool } from '../../src/main/import/thumbnail-pool.js';
import { ThumbnailService } from '../../src/main/import/thumbnail-service.js';
import type { EnvelopeKey } from '../../src/main/crypto/envelope.js';

const WORKER_URL = new URL('../../src/main/import/thumbnail-worker.js', import.meta.url);
const CRASH_WORKER_URL = new URL('../../../tests/fixtures/import/crash-worker.js', import.meta.url);
const FIXTURES = join(import.meta.dirname, '../../../tests/fixtures/exif');
const HEIC_FIXTURES = join(import.meta.dirname, '../../../tests/fixtures/heic');

/** Deterministic junk — undecodable as any image format. Deliberately NOT
 * crypto randomness: CodeQL taint-tracks randomBytes into the RAF header
 * arithmetic and misreads format parsing as biased crypto. */
function junkBytes(length: number): Buffer {
  return Buffer.from(Array.from({ length }, (_, index) => (index * 131 + 7) % 256));
}

const pool = new ThumbnailPool({ workerUrl: WORKER_URL, size: 2 });
after(async () => {
  await pool.close();
});

function isWebp(bytes: Buffer | undefined): boolean {
  return bytes !== undefined && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

describe('thumbnail pipeline (#86)', () => {
  test('EXIT CRITERIA: a JPEG yields both ADR-0006 WebP derivatives', async () => {
    const jpeg = readFileSync(join(FIXTURES, 'exif-full.jpg'));
    const result = await pool.generate(jpeg);
    assert.notEqual(result, null);
    assert.ok(isWebp(result?.thumb), 'thumb is WebP');
    assert.ok(isWebp(result?.mid), 'mid is WebP');
    assert.equal(result?.width, 1280);
    assert.equal(result?.height, 838);
  });

  test('reported dimensions match orientation-normalized derivative pixels (#500)', async () => {
    const oriented = await sharp({
      create: { width: 30, height: 20, channels: 3, background: '#d33' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const result = await pool.generate(oriented);
    assert.ok(result !== null && !('failure' in result));
    assert.deepEqual({ width: result.width, height: result.height }, { width: 20, height: 30 });
  });

  test('EXIT CRITERIA: RAF resolves the embedded preview first', async () => {
    const raf = readFileSync(join(FIXTURES, 'sample.raf'));
    const result = await pool.generate(raf);
    assert.notEqual(result, null, 'a RAF with a preview must produce derivatives');
    assert.ok(isWebp(result?.thumb));
  });

  test('EXIT CRITERIA: native HEIC decode produces oriented WebP derivatives (#487)', { skip: process.platform !== 'darwin' }, async () => {
    for (const [name, dimensions] of [
      ['iphone-xr.heic', { width: 4032, height: 3024 }],
      ['iphone-13-pro.heic', { width: 3024, height: 4032 }],
    ] as const) {
      const result = await pool.generate(readFileSync(join(HEIC_FIXTURES, name)), undefined, 'heic');
      assert.ok(result !== null && !('failure' in result), `${name} must decode`);
      assert.ok(isWebp(result.thumb));
      assert.ok(isWebp(result.mid));
      assert.deepEqual({ width: result.width, height: result.height }, dimensions);
    }
  });

  test('EXIT CRITERIA: undecodable bytes yield the placeholder marker (null), not a failure', async () => {
    assert.equal(await pool.generate(junkBytes(256)), null);
    // A corrupt "JPEG" (SOI then garbage) is the same placeholder, and the
    // worker survives to serve the next real job.
    assert.equal(await pool.generate(readFileSync(join(FIXTURES, 'corrupt.jpg'))), null);
    assert.notEqual(await pool.generate(readFileSync(join(FIXTURES, 'exif-full.jpg'))), null);
  });

  test('derivatives strip metadata — camera identity must not survive', async () => {
    const jpeg = readFileSync(join(FIXTURES, 'exif-full.jpg'));
    const result = await pool.generate(jpeg);
    const thumb = result?.thumb ?? Buffer.alloc(0);
    assert.ok(jpeg.includes(Buffer.from('FUJIFILM', 'ascii')), 'source carries the make');
    assert.equal(thumb.includes(Buffer.from('FUJIFILM', 'ascii')), false, 'derivative must not');
    assert.equal(thumb.includes(Buffer.from('Exif', 'ascii')), false);
  });

  test('cancellation drains queued jobs without spending worker time', async () => {
    const jpeg = readFileSync(join(FIXTURES, 'exif-full.jpg'));
    const controller = new AbortController();
    controller.abort();
    assert.equal(await pool.generate(jpeg, controller.signal), null);
  });

  test('EXIT CRITERIA: a crashed worker rejects its job, the queue never hangs', async () => {
    // A "worker" that dies on arrival — whether it exits before or after the
    // job dispatch, the pool must reject that job, correct its capacity
    // books, and stay usable. Two sequential jobs prove no capacity leak:
    // with broken idle-crash accounting the second generate() would deadlock
    // waiting on a phantom worker.
    const crashy = new ThumbnailPool({ workerUrl: CRASH_WORKER_URL, size: 1 });
    const jpeg = readFileSync(join(FIXTURES, 'exif-full.jpg'));
    await assert.rejects(crashy.generate(jpeg), /exited with code/u);
    await assert.rejects(crashy.generate(jpeg), /exited with code/u);
    await crashy.close();
  });

  test('a worker error at module init surfaces as the job rejection, not a process crash', async () => {
    // Uncaught worker 'error' events rethrow on main unless consumed (PR
    // #182 review): the pool must swallow the event and carry its message
    // into the exit rejection.
    const throwy = new ThumbnailPool({ workerUrl: new URL('../../../tests/fixtures/import/throw-worker.js', import.meta.url), size: 1 });
    const jpeg = readFileSync(join(FIXTURES, 'exif-full.jpg'));
    await assert.rejects(throwy.generate(jpeg), /boom at module init/u);
    await throwy.close();
  });

  test('close() settles a queued backlog instead of hanging (PR #182 review)', async () => {
    const hangy = new ThumbnailPool({ workerUrl: new URL('../../../tests/fixtures/import/hang-worker.js', import.meta.url), size: 1 });
    const jpeg = readFileSync(join(FIXTURES, 'exif-full.jpg'));
    // Handlers attach BEFORE close(): the drain rejects synchronously.
    const dispatched = assert.rejects(hangy.generate(jpeg), /exited with code/u, 'terminate() rejects the in-flight job');
    const queued = assert.rejects(hangy.generate(jpeg), /pool is closed/u, 'the queued job is drained, not orphaned');
    await hangy.close();
    await queued;
    await dispatched;
  });

  test('EXIT CRITERIA: fixture set through the service — encrypted thumbs + one placeholder, no plaintext', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'overlook-thumbgen-'));
    const store = new BlobStore({ dataDir });
    await store.init();
    const key: EnvelopeKey = { id: 1, key: randomBytes(32) };
    const service = new ThumbnailService(pool, store);

    // JPEG + RAF generate; the unsupported file records a placeholder.
    const fixtures = [
      { name: 'exif-full.jpg', hash: 'a'.repeat(64) },
      { name: 'sample.raf', hash: 'b'.repeat(64) },
      { name: 'corrupt.jpg', hash: 'c'.repeat(64) },
    ];
    const outcomes = [];
    for (const [index, fixture] of fixtures.entries()) {
      outcomes.push(
        await service.generateFor({
          photoId: `PHOTOGEN${String(index)}`,
          bytes: readFileSync(join(FIXTURES, fixture.name)),
          contentHash: fixture.hash,
          key,
        }),
      );
    }
    assert.deepEqual(
      outcomes.map((outcome) => outcome.generated),
      [true, true, false],
    );

    // Encrypt-then-move: no file anywhere under the store is plaintext WebP,
    // and no staging leftovers survive.
    for (const name of readdirSync(dataDir, { recursive: true, encoding: 'utf8' })) {
      const path = join(dataDir, name);
      if (!statSync(path).isFile()) {
        continue;
      }
      assert.equal(isWebp(readFileSync(path)), false, `plaintext derivative at ${name}`);
    }
    assert.deepEqual(readdirSync(join(dataDir, 'tmp')), [], 'no staging leftovers');

    // And the stored derivative round-trips through decrypt byte-exact.
    const jpeg = readFileSync(join(FIXTURES, 'exif-full.jpg'));
    const expected = await pool.generate(jpeg);
    const decrypted = await buffer(store.getThumbStream('a'.repeat(64), 'thumb', () => key.key, 'PHOTOGEN0'));
    assert.deepEqual(decrypted, expected?.thumb);
  });
});

// #493: a saved edit re-bakes the derivatives from the original with the
// head's transform — the original is never touched, the derivatives are.
describe('edit transforms in the thumbnail worker (#493)', () => {
  async function source(): Promise<Buffer> {
    return sharp({ create: { width: 30, height: 20, channels: 3, background: '#3a3' } })
      .jpeg()
      .toBuffer();
  }

  test('a quarter turn swaps the derivative axes', async () => {
    const result = await pool.generate(await source(), undefined, 'jpeg', { quarterTurns: 1, flipped: false, crop: null });
    assert.ok(result !== null && !('failure' in result));
    // The record keeps the ORIGINAL's dimensions; only the derivatives turn.
    assert.deepEqual({ width: result.width, height: result.height }, { width: 30, height: 20 });
    const mid = await sharp(result.mid).metadata();
    assert.deepEqual({ width: mid.width, height: mid.height }, { width: 20, height: 30 });
  });

  test('a crop bakes only the framed region; the identity transform is a plain derivative', async () => {
    const cropped = await pool.generate(await source(), undefined, 'jpeg', {
      quarterTurns: 0,
      flipped: false,
      crop: { left: 0, top: 0, width: 0.5, height: 1 },
    });
    assert.ok(cropped !== null && !('failure' in cropped));
    const croppedMid = await sharp(cropped.mid).metadata();
    assert.deepEqual({ width: croppedMid.width, height: croppedMid.height }, { width: 15, height: 20 });
    const plain = await pool.generate(await source(), undefined, 'jpeg', { quarterTurns: 0, flipped: false, crop: null });
    assert.ok(plain !== null && !('failure' in plain));
    const plainMid = await sharp(plain.mid).metadata();
    assert.deepEqual({ width: plainMid.width, height: plainMid.height }, { width: 30, height: 20 });
  });
});
