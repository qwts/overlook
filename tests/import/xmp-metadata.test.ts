import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { extractXmpKeywords } from '../../src/main/import/xmp-metadata.js';

describe('XMP keyword projection (#508)', () => {
  test('normalizes dc:subject and legacy Keywords without mutating source bytes', () => {
    const source = Buffer.from(`
      <x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:subject><rdf:Bag><rdf:li> Travel </rdf:li><rdf:li>Night &amp; Light</rdf:li></rdf:Bag></dc:subject>
        <Keywords>Portfolio; travel</Keywords>
      </x:xmpmeta>`);
    const before = Buffer.from(source);
    assert.deepEqual(extractXmpKeywords(source), ['Night & Light', 'Portfolio', 'Travel']);
    assert.deepEqual(source, before, 'the original sidecar remains byte-identical');
  });

  test('fails closed for empty, malformed, or oversized input', () => {
    assert.deepEqual(extractXmpKeywords(Buffer.alloc(0)), []);
    assert.deepEqual(extractXmpKeywords(Buffer.from('<subject><li>unfinished')), []);
    assert.deepEqual(extractXmpKeywords(Buffer.alloc(5 * 1024 * 1024 + 1)), []);
  });
});
