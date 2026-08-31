import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createClipTokenizer } from '../../src/main/embedding/clip-tokenizer.js';

describe('CLIP tokenizer', () => {
  test('normalizes text and wraps the pinned special tokens', () => {
    const tokenize = createClipTokenizer({ model: { merges: [], vocab: { 'a</w>': 42 } } });
    assert.deepEqual(tokenize('  A  '), [49_406, 42, 49_407]);
  });

  test('rejects a malformed tokenizer asset', () => {
    assert.throws(() => createClipTokenizer({}), /invalid CLIP tokenizer/);
  });
});
