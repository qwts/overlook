import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import type { ThumbnailDerivatives } from '../../src/main/import/thumbnail-pool.js';
import { ThumbnailService } from '../../src/main/import/thumbnail-service.js';

function gate() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

test('an older replacement cannot finish over a newer edit, including a late-loaded old request (#1115)', async () => {
  const blobs = new BlobStore({ dataDir: mkdtempSync(join(tmpdir(), 'overlook-bake-order-')) });
  await blobs.init();
  const key = { id: 1, key: Buffer.alloc(32, 9) };
  const entered = gate();
  const release = gate();
  const replace = blobs.replaceThumb.bind(blobs);
  let writes = 0;
  blobs.replaceThumb = async (...args: Parameters<BlobStore['replaceThumb']>) => {
    if (++writes === 2) {
      entered.resolve();
      await release.promise;
    }
    return replace(...args);
  };
  const generated: string[] = [];
  const service = new ThumbnailService(
    {
      generate: (bytes: Buffer) => {
        generated.push(bytes.toString());
        return Promise.resolve({ thumb: Buffer.from(bytes), mid: Buffer.from(bytes), width: 1, height: 1 });
      },
    },
    blobs,
  );
  let head = 'old';
  const request = (revision: string) => ({
    photoId: 'photo',
    contentHash: 'a'.repeat(64),
    key,
    bytes: Buffer.from(revision),
    isCurrent: () => head === revision,
  });
  const old = service.regenerateFor(request('old'));
  await entered.promise; // The old thumb is written; its mid is still pending.
  head = 'new';
  const newer = service.regenerateFor(request('new'));
  release.resolve();
  assert.deepEqual(
    await old,
    { generated: false, width: null, height: null, discarded: true },
    'a superseded completion cannot settle debt or publish stale availability',
  );
  assert.equal((await newer).generated, true);
  assert.equal((await service.regenerateFor(request('old'))).generated, false, 'late old loads never publish');
  assert.deepEqual(generated, ['old', 'new']);
  for (const size of ['thumb', 'mid'] as const) {
    assert.equal((await buffer(blobs.getThumbStream('a'.repeat(64), size, () => key.key, 'photo'))).toString(), 'new');
  }
});

test('a failed replacement releases its queue and obsolete decoded buffers are zeroized (#1115)', async () => {
  const blobs = new BlobStore({ dataDir: mkdtempSync(join(tmpdir(), 'overlook-bake-failure-')) });
  await blobs.init();
  const key = { id: 1, key: Buffer.alloc(32, 9) };
  const thumb = Buffer.from('stale');
  const mid = Buffer.from('stale');
  let current = true;
  let calls = 0;
  const service = new ThumbnailService(
    {
      generate: (): Promise<ThumbnailDerivatives> => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('worker failed'));
        current = false;
        return Promise.resolve({ thumb, mid, width: 1, height: 1 });
      },
    },
    blobs,
  );
  const request = { photoId: 'photo', contentHash: 'a'.repeat(64), key, bytes: Buffer.from('original'), isCurrent: () => current };
  await assert.rejects(service.regenerateFor(request), /worker failed/u);
  assert.equal((await service.regenerateFor(request)).generated, false);
  assert.equal(calls, 2);
  assert.deepEqual(thumb, Buffer.alloc(5));
  assert.deepEqual(mid, Buffer.alloc(5));
  assert.equal(await blobs.verifyThumbs(request.contentHash, () => key.key, request.photoId), false);
});

for (const result of [null, { failure: 'decode-failed' as const }]) {
  test(`a superseded decode result (${result?.failure ?? 'empty'}) cannot publish availability (#1115)`, async () => {
    const blobs = new BlobStore({ dataDir: join(tmpdir(), 'overlook-discarded-decode') });
    let current = true;
    const service = new ThumbnailService(
      {
        generate: () => {
          current = false;
          return Promise.resolve(result);
        },
      },
      blobs,
    );
    assert.deepEqual(
      await service.regenerateFor({
        photoId: 'photo',
        contentHash: 'a'.repeat(64),
        key: { id: 1, key: Buffer.alloc(32, 9) },
        bytes: Buffer.from('original'),
        isCurrent: () => current,
      }),
      { generated: false, width: null, height: null, discarded: true },
    );
  });
}
