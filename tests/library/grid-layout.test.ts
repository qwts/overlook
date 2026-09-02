import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  anchorIndex,
  computeFeedLayout,
  computeLayout,
  computeListLayout,
  needsMore,
  scrollTopForAnchor,
  tilePosition,
  visibleRange,
} from '../../src/shared/library/grid-layout.js';

const GAP = 4;

describe('grid layout math', () => {
  test('columns follow auto-fill minmax semantics and tiles stretch to fill', () => {
    // 1000px viewport, 4px outer padding both sides → 992 inner.
    // (992 + 4) / (160 + 4) = 6.07 → 6 columns.
    const layout = computeLayout({ viewportWidth: 1000, zoom: 160, gap: GAP, total: 100 });
    assert.equal(layout.columns, 6);
    // 6 tiles + 5 gaps fill 992 exactly.
    assert.equal(layout.tileSize * 6 + GAP * 5, 992);
    assert.ok(layout.tileSize >= 160);
    assert.equal(layout.rowHeight, layout.tileSize + GAP);
  });

  test('never fewer than one column, even when the viewport is narrower than zoom', () => {
    const layout = computeLayout({ viewportWidth: 200, zoom: 320, gap: GAP, total: 10 });
    assert.equal(layout.columns, 1);
    assert.equal(layout.tileSize, 192); // 200 - 2*4
  });

  test('total height covers every row plus outer padding, zero when empty', () => {
    const layout = computeLayout({ viewportWidth: 1000, zoom: 160, gap: GAP, total: 100 });
    assert.equal(layout.rows, Math.ceil(100 / 6));
    assert.equal(layout.totalHeight, 2 * GAP + layout.rows * layout.rowHeight - GAP);
    assert.equal(computeLayout({ viewportWidth: 1000, zoom: 160, gap: GAP, total: 0 }).totalHeight, 0);
  });

  test('visible range windows rows with overscan and clamps at both ends', () => {
    const layout = computeLayout({ viewportWidth: 1000, zoom: 160, gap: GAP, total: 100_000 });
    const atTop = visibleRange(layout, 0, 800, 2);
    assert.equal(atTop.firstRow, 0);
    assert.equal(atTop.firstIndex, 0);
    assert.ok(atTop.lastRow >= Math.floor(800 / layout.rowHeight));

    const mid = visibleRange(layout, 50 * layout.rowHeight + GAP, 800, 2);
    assert.equal(mid.firstRow, 48); // 50 minus overscan
    assert.equal(mid.firstIndex, 48 * layout.columns);

    const bottom = visibleRange(layout, layout.totalHeight, 800, 2);
    assert.equal(bottom.lastRow, layout.rows - 1);
    assert.equal(bottom.lastIndex, layout.total - 1);
  });

  test('visible range is empty for an empty library', () => {
    const layout = computeLayout({ viewportWidth: 1000, zoom: 160, gap: GAP, total: 0 });
    const range = visibleRange(layout, 0, 800, 2);
    assert.ok(range.lastIndex < range.firstIndex);
  });

  test('scroll offset past a shrunken layout still renders the final rows (PR #156 review)', () => {
    // Deep in All Photos (200K), then the source switches to a 3-photo set:
    // the stale scrollTop is far beyond the new plane.
    const big = computeLayout({ viewportWidth: 1000, zoom: 160, gap: GAP, total: 200_000 });
    const small = computeLayout({ viewportWidth: 1000, zoom: 160, gap: GAP, total: 3 });
    const staleScrollTop = 30_000 * big.rowHeight;
    const range = visibleRange(small, staleScrollTop, 800, 2);
    assert.ok(range.firstIndex <= range.lastIndex, 'window must not collapse');
    assert.equal(range.lastIndex, 2, 'the final photos render');
  });

  test('tile positions tile the plane exactly: no overlap, gap-separated', () => {
    const layout = computeLayout({ viewportWidth: 1000, zoom: 160, gap: GAP, total: 100 });
    const first = tilePosition(layout, 0);
    assert.deepEqual(first, { left: GAP, top: GAP });
    const second = tilePosition(layout, 1);
    assert.equal(second.left - first.left, layout.tileSize + GAP);
    const nextRow = tilePosition(layout, layout.columns);
    assert.equal(nextRow.left, GAP);
    assert.equal(nextRow.top - first.top, layout.rowHeight);
  });

  test('zoom change keeps the anchor photo visible (round-trip)', () => {
    const before = computeLayout({ viewportWidth: 1200, zoom: 96, gap: GAP, total: 200_000 });
    const scrollTop = 4321 * before.rowHeight; // deep in the library
    const anchor = anchorIndex(before, scrollTop);
    assert.notEqual(anchor, null);

    const after = computeLayout({ viewportWidth: 1200, zoom: 320, gap: GAP, total: 200_000 });
    const restored = scrollTopForAnchor(after, anchor ?? 0);
    // The anchor photo's row is exactly at the top of the viewport.
    const { top } = tilePosition(after, anchor ?? 0);
    assert.equal(top - restored, GAP);
    // And it is inside the new visible range.
    const range = visibleRange(after, restored, 800, 0);
    assert.ok((anchor ?? 0) >= range.firstIndex && (anchor ?? 0) <= range.lastIndex);
  });

  test('anchor is null for an empty library and clamps to the last photo', () => {
    const empty = computeLayout({ viewportWidth: 1000, zoom: 160, gap: GAP, total: 0 });
    assert.equal(anchorIndex(empty, 500), null);
    const small = computeLayout({ viewportWidth: 1000, zoom: 160, gap: GAP, total: 3 });
    assert.equal(anchorIndex(small, 10_000_000), 0); // single row: clamped to row 0
  });

  test('prefetch triggers near the loaded frontier and stops at the total', () => {
    const layout = computeLayout({ viewportWidth: 1000, zoom: 160, gap: GAP, total: 10_000 });
    const nearFrontier = visibleRange(layout, scrollTopForAnchor(layout, 480), 800, 2);
    assert.equal(needsMore(layout, nearFrontier, 500, 6), true);
    const farFromFrontier = visibleRange(layout, 0, 800, 2);
    assert.equal(needsMore(layout, farFromFrontier, 500, 6), false);
    // Fully loaded: never asks again.
    assert.equal(needsMore(layout, nearFrontier, 10_000, 6), false);
    // Empty range never asks.
    const empty = computeLayout({ viewportWidth: 1000, zoom: 160, gap: GAP, total: 0 });
    assert.equal(needsMore(empty, visibleRange(empty, 0, 800, 2), 0, 6), false);
  });

  test('200K layout arithmetic stays exact at the extremes', () => {
    const layout = computeLayout({ viewportWidth: 2560, zoom: 96, gap: GAP, total: 200_000 });
    const last = tilePosition(layout, 199_999);
    assert.ok(last.top + layout.tileSize <= layout.totalHeight);
    const range = visibleRange(layout, layout.totalHeight - 800, 800, 2);
    assert.equal(range.lastIndex, 199_999);
  });

  test('list mode (#77): single column, fixed 52px rows, full-width cells', () => {
    const layout = computeListLayout({ viewportWidth: 900, rowHeight: 52, gap: 2, padding: 8, total: 1000 });
    assert.equal(layout.columns, 1);
    assert.equal(layout.cellWidth, 884); // 900 - 2*8
    assert.equal(layout.tileSize, 52);
    assert.equal(layout.rowHeight, 54);
    assert.equal(layout.totalHeight, 16 + 1000 * 54 - 2);
    assert.deepEqual(tilePosition(layout, 10), { left: 8, top: 8 + 10 * 54 });
    const range = visibleRange(layout, 8 + 54 * 100, 700, 2);
    assert.equal(range.firstIndex, 98); // row 100 minus overscan
    assert.ok(range.lastIndex >= 100 + Math.floor(700 / 54));
  });

  test('feed mode centers one capped column of fixed-height cards (#516)', () => {
    const spec = { viewportWidth: 1200, cardHeight: 536, gap: 16, padding: 16, maxWidth: 720, total: 12 };
    const wide = computeFeedLayout(spec);
    assert.equal(wide.columns, 1);
    assert.equal(wide.cellWidth, 720);
    assert.equal(wide.columnStart, 16 + (1168 - 720) / 2);
    assert.equal(wide.tileSize, 536);
    assert.equal(wide.rowHeight, 552);
    assert.equal(wide.totalHeight, 32 + 12 * 552 - 16);
    assert.deepEqual(tilePosition(wide, 3), { left: wide.columnStart, top: 16 + 3 * 552 });
    // Narrower than the cap: the column fills the inner width from the padding.
    const narrow = computeFeedLayout({ ...spec, viewportWidth: 600 });
    assert.equal(narrow.cellWidth, 568);
    assert.equal(narrow.columnStart, 16);
    assert.equal(computeFeedLayout({ ...spec, total: 0 }).totalHeight, 0);
    // A grid anchor lands inside the feed window after the mode switch.
    const grid = computeLayout({ viewportWidth: 1200, zoom: 160, gap: GAP, total: 12 });
    const anchor = anchorIndex(grid, grid.rowHeight) ?? 0;
    const range = visibleRange(wide, scrollTopForAnchor(wide, anchor), 800, 0);
    assert.ok(anchor >= range.firstIndex && anchor <= range.lastIndex);
  });

  test('grid → list toggle keeps the anchor photo in the window', () => {
    const grid = computeLayout({ viewportWidth: 900, zoom: 160, gap: GAP, total: 1000 });
    const list = computeListLayout({ viewportWidth: 900, rowHeight: 52, gap: 2, padding: 8, total: 1000 });
    const anchor = anchorIndex(grid, 40 * grid.rowHeight);
    const restored = scrollTopForAnchor(list, anchor ?? 0);
    const range = visibleRange(list, restored, 700, 0);
    assert.ok((anchor ?? 0) >= range.firstIndex && (anchor ?? 0) <= range.lastIndex);
  });
});
