import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { HISTOGRAM_BINS, binHistogram, histogramDigest } from '../../src/shared/library/histogram.js';

// #498: the binning is pure and display-referred — counts per encoded value,
// Rec. 709 luma rounded to the nearest bin, clipping as the share of pixels
// at either end. Alpha is ignored; grey feeds every channel.

function rgb(pixels: readonly (readonly [number, number, number])[]): Uint8Array {
  return Uint8Array.from(pixels.flatMap(([r, g, b]) => [r, g, b]));
}

describe('histogram binning (#498)', () => {
  test('counts every sample into its bin and reports clipping as a fraction of pixels', () => {
    const samples = rgb([
      [0, 0, 0],
      [255, 255, 255],
      [255, 128, 0],
      [10, 20, 30],
    ]);
    const data = binHistogram(samples, 2, 2, 3);
    assert.equal(data.pixels, 4);
    assert.equal(data.channels.red.length, HISTOGRAM_BINS);
    assert.deepEqual([data.channels.red[0], data.channels.red[255], data.channels.red[10]], [1, 2, 1]);
    assert.deepEqual([data.channels.green[128], data.channels.green[20]], [1, 1]);
    assert.deepEqual([data.channels.blue[0], data.channels.blue[30]], [2, 1]);
    assert.deepEqual(data.clipping.shadows, { red: 0.25, green: 0.25, blue: 0.5 });
    assert.deepEqual(data.clipping.highlights, { red: 0.5, green: 0.25, blue: 0.25 });
    assert.equal(
      data.channels.red.reduce((sum, count) => sum + count, 0),
      4,
      'every pixel lands in exactly one bin',
    );
  });

  test('luma is Rec. 709 over the encoded values, rounded to the nearest bin', () => {
    const data = binHistogram(rgb([[255, 0, 0]]), 1, 1, 3);
    assert.equal(data.channels.luma[Math.round(0.2126 * 255)], 1);
    const white = binHistogram(rgb([[255, 255, 255]]), 1, 1, 3);
    assert.equal(white.channels.luma[255], 1);
  });

  test('alpha is ignored and grey feeds every channel', () => {
    const rgba = Uint8Array.from([7, 8, 9, 0, 7, 8, 9, 255]);
    const data = binHistogram(rgba, 2, 1, 4);
    assert.deepEqual([data.channels.red[7], data.channels.green[8], data.channels.blue[9]], [2, 2, 2]);
    assert.equal(data.clipping.highlights.red, 0, 'the alpha 255 never counts as a clipped red');
    const grey = binHistogram(Uint8Array.from([200, 200, 3]), 3, 1, 1);
    assert.deepEqual([grey.channels.red[200], grey.channels.green[200], grey.channels.blue[200], grey.channels.luma[200]], [2, 2, 2, 2]);
    assert.equal(grey.channels.luma[3], 1);
  });

  test('a short buffer or an impossible channel count is refused, never binned', () => {
    assert.throws(() => binHistogram(Uint8Array.from([1, 2]), 1, 1, 3), RangeError);
    assert.throws(() => binHistogram(Uint8Array.from([1]), 1, 1, 5), RangeError);
    const empty = binHistogram(new Uint8Array(0), 0, 0, 3);
    assert.equal(empty.pixels, 0);
    assert.deepEqual(empty.clipping.shadows, { red: 0, green: 0, blue: 0 });
  });

  test('the digest is stable for equal bins and differs when a bin moves', () => {
    const one = binHistogram(rgb([[1, 2, 3]]), 1, 1, 3);
    const same = binHistogram(rgb([[1, 2, 3]]), 1, 1, 3);
    const other = binHistogram(rgb([[1, 2, 4]]), 1, 1, 3);
    assert.equal(histogramDigest(one.channels), histogramDigest(same.channels));
    assert.notEqual(histogramDigest(one.channels), histogramDigest(other.channels));
    assert.match(histogramDigest(one.channels), /^[0-9a-f]{8}$/u);
  });
});
