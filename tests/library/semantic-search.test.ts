import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { reciprocalRankFusion } from '../../src/main/library/semantic-search.js';

describe('semantic search ranking', () => {
  test('uses deterministic reciprocal-rank fusion with overlap rewarded', () => {
    const ranked = reciprocalRankFusion(['keyword', 'both'], ['semantic', 'both'], 'fused');
    assert.equal(ranked[0]?.id, 'both');
    assert.deepEqual(
      ranked.slice(1).map(({ id }) => id),
      ['keyword', 'semantic'],
      'equal scores use stable photo ids',
    );
  });

  test('semantic mode does not leak keyword-only candidates', () => {
    assert.deepEqual(
      reciprocalRankFusion(['keyword'], ['semantic'], 'semantic').map(({ id }) => id),
      ['semantic'],
    );
  });
});
