import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import { readPrefix } from '../../src/main/library/provenance-runtime.js';

// #495 (#1113 review): opening the Inspector must never materialize a whole
// original. The runtime reads only the extractor's scan window and stops the
// stream, so the producer behind it is torn down instead of drained.

function producer(chunkBytes: number, chunks: number): { readonly stream: Readable; produced: () => number; destroyed: () => boolean } {
  let produced = 0;
  let index = 0;
  const stream = new Readable({
    read() {
      if (index >= chunks) {
        this.push(null);
        return;
      }
      produced += 1;
      this.push(Buffer.alloc(chunkBytes, index));
      index += 1;
    },
  });
  return { stream, produced: () => produced, destroyed: () => stream.destroyed };
}

describe('provenance runtime bounded read (#495)', () => {
  test('returns exactly the leading window and stops the stream early', async () => {
    const source = producer(1024, 1000);
    const prefix = await readPrefix(source.stream, 4096);
    assert.equal(prefix.length, 4096);
    assert.equal(prefix[0], 0);
    assert.equal(prefix[4095], 3);
    assert.ok(source.produced() < 1000, `produced ${String(source.produced())} chunks, expected an early stop`);
    assert.ok(source.destroyed(), 'the stream is destroyed once the window is read');
  });

  test('a stream shorter than the window is read in full', async () => {
    const source = producer(100, 3);
    const prefix = await readPrefix(source.stream, 4096);
    assert.equal(prefix.length, 300);
    assert.equal(source.produced(), 3);
  });

  test('a window that splits a chunk is truncated to the limit', async () => {
    const source = producer(1000, 2);
    const prefix = await readPrefix(source.stream, 1500);
    assert.equal(prefix.length, 1500);
    assert.equal(prefix[1499], 1);
  });
});
