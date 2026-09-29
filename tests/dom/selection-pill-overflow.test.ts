import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collapseLevels, overflowFor, type PillActionId } from '../../src/renderer/src/grid/selection-pill-actions.js';

// #1304, Pass E spec: inline order, and the priority that decides which
// action leaves first (6 first … 1 last).
const LIBRARY: readonly PillActionId[] = ['offload', 'transfer', 'export', 'add', 'original', 'trash'];
const ALBUM: readonly PillActionId[] = ['offload', 'transfer', 'export', 'add', 'original', 'remove'];
const TRASH: readonly PillActionId[] = ['restore', 'purge'];

function inlineAt(order: readonly PillActionId[], level: number): readonly PillActionId[] {
  const overflow = new Set(overflowFor(order, level));
  return order.filter((id) => !overflow.has(id));
}

test('each level moves exactly one more action to ⋯, lowest priority first', () => {
  const leaving = [1, 2, 3, 4, 5, 6].map((level) =>
    overflowFor(LIBRARY, level).find((id) => !overflowFor(LIBRARY, level - 1).includes(id)),
  );
  assert.deepEqual(leaving, ['transfer', 'original', 'offload', 'add', 'trash', 'export']);
  assert.deepEqual(overflowFor(TRASH, 1), ['purge']);
  assert.deepEqual(overflowFor(TRASH, 2), ['restore', 'purge']);
});

test('an action is never inline and in ⋯ at once, and ⋯ is empty only at level 0', () => {
  for (const order of [LIBRARY, ALBUM, TRASH]) {
    for (let level = 0; level <= order.length; level += 1) {
      const overflow = overflowFor(order, level);
      const inline = inlineAt(order, level);
      assert.deepEqual(
        inline.filter((id) => overflow.includes(id)),
        [],
      );
      assert.equal(inline.length + overflow.length, order.length);
      assert.equal(overflow.length, level, `${order.join()} at ${String(level)}`);
    }
  }
});

test('⋯ lists its actions in inline order, not priority order', () => {
  assert.deepEqual(overflowFor(LIBRARY, 3), ['offload', 'transfer', 'original']);
  assert.deepEqual(overflowFor(ALBUM, 6), ALBUM);
});

test('absent actions are skipped, so the next one leaves at level 1', () => {
  const noTransferNoMark: readonly PillActionId[] = ['offload', 'export', 'add', 'trash'];
  assert.deepEqual(overflowFor(noTransferNoMark, 1), ['offload']);
  assert.equal(collapseLevels(noTransferNoMark).get('export'), 4);
});
