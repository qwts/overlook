import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gridTotal } from '../../src/renderer/src/grid/grid-total.js';

test('a rejected first page does not reserve one blank tile', () => {
  assert.equal(gridTotal({ filtersActive: false, knownTotal: null, loaded: 0, exhausted: false, pageFailed: true }), 0);
});

test('an in-flight page with no count still reserves one placeholder', () => {
  assert.equal(gridTotal({ filtersActive: false, knownTotal: null, loaded: 0, exhausted: false, pageFailed: false }), 1);
});

test('a known total is used once the page has not failed', () => {
  assert.equal(gridTotal({ filtersActive: false, knownTotal: 12, loaded: 0, exhausted: false, pageFailed: false }), 12);
});
