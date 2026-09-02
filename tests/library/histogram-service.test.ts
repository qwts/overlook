import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import sharp from 'sharp';

import { HistogramDecodeError, HistogramRunner } from '../../src/main/library/histogram-runner.js';
import { HistogramService, type HistogramServiceDeps } from '../../src/main/library/histogram-service.js';
import type { HistogramData } from '../../src/shared/library/histogram.js';
import type { PhotoRecord } from '../../src/shared/library/types.js';

// #498: the service answers per photo from the photo's own mid derivative,
// caches per head revision and derivative key, dedupes concurrent asks,
// and reports missing / preview-failure / corrupt honestly. The runner
// test drives the real worker over real image bytes.

const WORKER_URL = new URL('../../src/main/library/histogram-worker.js', import.meta.url);

const runner = new HistogramRunner({ workerUrl: WORKER_URL });
after(async () => {
  await runner.close();
});

function photo(id: string, overrides: Partial<PhotoRecord> = {}): PhotoRecord {
  return { id, derivativeKey: `key-${id}`, previewFailure: null, ...overrides } as PhotoRecord;
}

function fakeData(seed: number): HistogramData {
  const bins = Array.from({ length: 256 }, (_, index) => (index === seed ? 1 : 0));
  return {
    width: 1,
    height: 1,
    pixels: 1,
    channels: { red: bins, green: bins, blue: bins, luma: bins },
    clipping: { shadows: { red: 0, green: 0, blue: 0 }, highlights: { red: 0, green: 0, blue: 0 } },
  };
}

interface Harness {
  readonly service: HistogramService;
  readonly loads: string[];
  readonly computes: number;
  head: string | null;
}

function harness(overrides: Partial<HistogramServiceDeps> = {}): Harness {
  const photos = new Map<string, PhotoRecord>([
    ['P1', photo('P1')],
    ['P2', photo('P2')],
    ['BAD', photo('BAD', { previewFailure: 'corrupt' })],
  ]);
  const state = { loads: [] as string[], computes: 0, head: null as string | null };
  const loadMid = overrides.loadMid ?? (() => Promise.resolve(Buffer.from([1, 2, 3])));
  const service = new HistogramService({
    repo: { get: (id) => photos.get(id) },
    headRevisionId: () => state.head,
    compute: () => {
      state.computes += 1;
      return Promise.resolve(fakeData(state.computes));
    },
    ...overrides,
    loadMid: (record) => {
      state.loads.push(record.id);
      return loadMid(record);
    },
  });
  return {
    service,
    loads: state.loads,
    get computes() {
      return state.computes;
    },
    get head() {
      return state.head;
    },
    set head(value: string | null) {
      state.head = value;
    },
  };
}

describe('histogram service (#498)', () => {
  test('answers from the mid derivative and caches per head revision and derivative key', async () => {
    const h = harness();
    const first = await h.service.get('P1');
    assert.equal(first.state, 'ready');
    if (first.state !== 'ready') return;
    assert.deepEqual(
      { source: first.source, revisionId: first.revisionId, pixels: first.pixels },
      { source: 'mid', revisionId: null, pixels: 1 },
    );
    assert.match(first.digest, /^[0-9a-f]{8}$/u);
    const again = await h.service.get('P1');
    assert.equal(again, first, 'same head, same key — the cached answer');
    assert.equal(h.computes, 1);
    // A saved edit advances the head: the derivative was re-baked, so the bins are recomputed.
    h.head = '01J8EDT000000000000000000A';
    const edited = await h.service.get('P1');
    assert.equal(edited.state, 'ready');
    assert.equal(h.computes, 2);
    if (edited.state === 'ready') assert.equal(edited.revisionId, '01J8EDT000000000000000000A');
    // Explicit invalidation (a repair replaced the derivative) recomputes too.
    h.service.invalidate(['P1']);
    await h.service.get('P1');
    assert.equal(h.computes, 3);
  });

  test('concurrent asks for one photo share one computation', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.service.get('P1'), h.service.get('P1')]);
    assert.equal(a, b);
    assert.equal(h.computes, 1);
    assert.deepEqual(h.loads, ['P1']);
  });

  test('unknown photos, recorded preview failures, absent derivatives and undecodable bytes are named, not cached', async () => {
    const h = harness({
      loadMid: (record) => Promise.resolve(record.id === 'P2' ? null : Buffer.from([1])),
      compute: () => Promise.reject(new HistogramDecodeError('not an image')),
    });
    assert.deepEqual(await h.service.get('ghost'), { state: 'unavailable', photoId: 'ghost', reason: 'missing' });
    assert.deepEqual(await h.service.get('BAD'), { state: 'unavailable', photoId: 'BAD', reason: 'preview-failure' });
    assert.deepEqual(await h.service.get('P2'), { state: 'unavailable', photoId: 'P2', reason: 'missing' });
    assert.deepEqual(await h.service.get('P1'), { state: 'unavailable', photoId: 'P1', reason: 'corrupt' });
    await h.service.get('P1');
    assert.deepEqual(h.loads, ['P2', 'P1', 'P1'], 'an unavailable answer is asked again next time');
  });

  test('an unexpected compute failure surfaces instead of masquerading as corrupt', async () => {
    const h = harness({ compute: () => Promise.reject(new Error('worker died')) });
    await assert.rejects(h.service.get('P1'), /worker died/u);
  });

  test('the cache is bounded, oldest answer out first', async () => {
    const photos = new Map<string, PhotoRecord>(Array.from({ length: 4 }, (_, index) => [`P${String(index)}`, photo(`P${String(index)}`)]));
    let computes = 0;
    const service = new HistogramService({
      repo: { get: (id) => photos.get(id) },
      headRevisionId: () => null,
      loadMid: () => Promise.resolve(Buffer.from([1])),
      compute: () => {
        computes += 1;
        return Promise.resolve(fakeData(computes));
      },
      cacheSize: 2,
    });
    await service.get('P0');
    await service.get('P1');
    await service.get('P2');
    await service.get('P0');
    assert.equal(computes, 4, 'P0 was evicted by P2 and recomputed');
    await service.get('P2');
    assert.equal(computes, 4, 'P2 is still cached');
  });
});

describe('histogram runner (#498)', () => {
  test('bins real image bytes on the worker thread', async () => {
    const png = await sharp({ create: { width: 4, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } } })
      .png()
      .toBuffer();
    const data = await runner.compute(png);
    assert.deepEqual({ width: data.width, height: data.height, pixels: data.pixels }, { width: 4, height: 2, pixels: 8 });
    assert.equal(data.channels.red[255], 8);
    assert.equal(data.channels.green[0], 8);
    assert.equal(data.clipping.highlights.red, 1);
    assert.equal(data.clipping.shadows.blue, 1);
    const webp = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } })
      .webp({ lossless: true })
      .toBuffer();
    const alpha = await runner.compute(webp);
    assert.equal(alpha.channels.luma[0], 4, 'alpha is dropped before binning');
  });

  test('undecodable bytes reject with HistogramDecodeError and the worker keeps serving', async () => {
    await assert.rejects(runner.compute(Buffer.from('not an image at all')), HistogramDecodeError);
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .png()
      .toBuffer();
    assert.equal((await runner.compute(png)).pixels, 1);
  });

  test('a closed runner refuses new work', async () => {
    const own = new HistogramRunner({ workerUrl: WORKER_URL });
    await own.close();
    await assert.rejects(own.compute(Buffer.from([0])), /closed/u);
  });
});
