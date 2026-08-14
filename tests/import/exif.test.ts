import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractMetadata } from '../../src/main/import/exif.js';
import { displayDimensions } from '../../src/main/import/display-dimensions.js';

const FIXTURES = join(import.meta.dirname, '../../../tests/fixtures/exif');

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, name));
}

describe('EXIF extraction (#85)', () => {
  test('display dimensions reject implausible metadata and apply EXIF orientation (#500)', () => {
    assert.deepEqual(displayDimensions(4032, 3024, 6), { width: 3024, height: 4032 });
    assert.deepEqual(displayDimensions(4032, 3024, 1), { width: 4032, height: 3024 });
    assert.equal(displayDimensions(0, 3024), null);
    assert.equal(displayDimensions(1.5, 2), null);
    assert.equal(displayDimensions(Number.MAX_SAFE_INTEGER + 1, 2), null);
  });

  test('EXIT CRITERIA: full EXIF JPEG yields the ADR-0006 field set', async () => {
    const meta = await extractMetadata(fixture('exif-full.jpg'));
    assert.equal(meta.width, 1280);
    assert.equal(meta.height, 838);
    assert.equal(meta.camera, 'FUJIFILM X-T5');
    assert.equal(meta.lens, 'XF35mmF1.4 R');
    assert.equal(meta.iso, 200);
    assert.equal(meta.aperture, '1.4');
    assert.equal(meta.shutter, '1/250');
    assert.equal(meta.focalLength, 35);
    // Floating wall clock: the EXIF digits verbatim, no offset — identical
    // whatever timezone the import runs in (Codex review, PR #176).
    assert.equal(meta.takenAt, '2026-06-12T12:34:56');
    assert.ok(Math.abs((meta.gpsLat ?? 0) - 38.7223) < 0.001);
    assert.ok(Math.abs((meta.gpsLon ?? 0) - -9.1393) < 0.001);
  });

  test('RAF resolves the embedded JPEG via the documented header offsets', async () => {
    const meta = await extractMetadata(fixture('sample.raf'));
    assert.equal(meta.width, 1280);
    assert.equal(meta.height, 838);
    assert.equal(meta.camera, 'FUJIFILM X-T5');
    assert.equal(meta.iso, 200);
    assert.equal(meta.aperture, '1.4');
  });

  test('stripped EXIF degrades to nulls — never fabricated', async () => {
    const meta = await extractMetadata(fixture('exif-stripped.jpg'));
    assert.equal(meta.camera, null);
    assert.equal(meta.lens, null);
    assert.equal(meta.iso, null);
    assert.equal(meta.aperture, null);
    assert.equal(meta.shutter, null);
    assert.equal(meta.takenAt, null);
    assert.equal(meta.gpsLat, null);
    assert.equal(meta.gpsLon, null);
  });

  test('EXIT CRITERIA: corrupt bytes yield a metadata-lite record, not an exception', async () => {
    const meta = await extractMetadata(fixture('corrupt.jpg'));
    assert.deepEqual(meta, {
      width: null,
      height: null,
      camera: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focalLength: null,
      takenAt: null,
      gpsLat: null,
      gpsLon: null,
      keywords: [],
    });
  });

  test('a RAF with a broken header falls back gracefully instead of throwing', async () => {
    const broken = Buffer.from('FUJIFILMCCD-RAW garbage-without-valid-offsets');
    const meta = await extractMetadata(broken);
    assert.equal(meta.camera, null);
  });

  test('shutter/aperture formatting follows the mock copy', async () => {
    // Formatting paths are pure — exercised through the full fixture above;
    // this asserts the exact strings the Inspector will render.
    const meta = await extractMetadata(fixture('exif-full.jpg'));
    assert.match(meta.shutter ?? '', /^1\/\d+$/);
    assert.match(meta.aperture ?? '', /^\d+(\.\d)?$/);
  });
});
