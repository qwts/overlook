import { test } from 'node:test';
import assert from 'node:assert/strict';

import { membershipChanged } from '../../src/shared/library/library-membership-change.js';

test('album changes invalidate selection only for the active album', () => {
  assert.equal(membershipChanged('album', 'all', {}, 'source', ['destination']), false);
  assert.equal(membershipChanged('album', 'all', {}, 'source', ['source', 'destination']), true);
  assert.equal(membershipChanged('album', 'all', {}, null, ['source']), false);
});

test('unscoped album changes remain conservative while metadata changes preserve selection', () => {
  assert.equal(membershipChanged('album', 'all', {}, 'source'), true);
  assert.equal(membershipChanged(undefined, 'all', {}, 'source'), false);
  assert.equal(membershipChanged('none', 'all', {}, 'source'), false);
});
