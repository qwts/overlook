// Virtualized grid math (#74) — pure arithmetic, no DOM. Decision recorded
// on the issue: fixed square tiles + constant gap make the layout exact, so
// a dependency (TanStack Virtual) would buy dynamic measurement we never
// need. The renderer feeds viewport numbers in; everything here is testable
// under the unit floor.

/** Grid geometry inputs. `zoom` is the requested tile size (96–320). */
export interface GridSpec {
  readonly viewportWidth: number;
  readonly zoom: number;
  /** Gap between tiles AND outer padding (mock uses --grid-gap for both). */
  readonly gap: number;
  readonly total: number;
}

export interface GridLayout {
  readonly columns: number;
  /** Cell HEIGHT (grid: stretched square side; list: the fixed row height). */
  readonly tileSize: number;
  /** Cell WIDTH (grid: equals tileSize; list: the full inner width). */
  readonly cellWidth: number;
  /** Vertical stride: tileSize + gap. */
  readonly rowHeight: number;
  readonly rows: number;
  /** Scrollable content height including outer padding. */
  readonly totalHeight: number;
  readonly gap: number;
  /** Outer padding (grid: equals gap; list: the mock's space-3). */
  readonly padding: number;
  /** Left edge of column 0 (grid and list: the padding; feed: centered). */
  readonly columnStart: number;
  readonly total: number;
}

export function computeLayout(spec: GridSpec): GridLayout {
  const { viewportWidth, zoom, gap, total } = spec;
  const innerWidth = Math.max(0, viewportWidth - 2 * gap);
  // Mock semantics: auto-fill minmax(zoom, 1fr) — as many zoom-wide columns
  // as fit, then stretch them to fill the row exactly.
  const columns = Math.max(1, Math.floor((innerWidth + gap) / (zoom + gap)));
  const tileSize = columns > 0 && innerWidth > 0 ? (innerWidth - (columns - 1) * gap) / columns : zoom;
  const rowHeight = tileSize + gap;
  const rows = total === 0 ? 0 : Math.ceil(total / columns);
  const totalHeight = rows === 0 ? 0 : 2 * gap + rows * rowHeight - gap;
  return { columns, tileSize, cellWidth: tileSize, rowHeight, rows, totalHeight, gap, padding: gap, columnStart: gap, total };
}

/** Single-column row mode (#77) — same windowing functions, list geometry. */
export interface ListSpec {
  readonly viewportWidth: number;
  readonly rowHeight: number;
  readonly gap: number;
  readonly padding: number;
  readonly total: number;
}

export function computeListLayout(spec: ListSpec): GridLayout {
  const { viewportWidth, rowHeight, gap, padding, total } = spec;
  const cellWidth = Math.max(0, viewportWidth - 2 * padding);
  const stride = rowHeight + gap;
  const rows = total;
  const totalHeight = rows === 0 ? 0 : 2 * padding + rows * stride - gap;
  return { columns: 1, tileSize: rowHeight, cellWidth, rowHeight: stride, rows, totalHeight, gap, padding, columnStart: padding, total };
}

/**
 * Feed mode (#516) — one centered column of fixed-height cards, capped at a
 * reading width. Same windowing functions; the engine never measures a card.
 */
export interface FeedSpec {
  readonly viewportWidth: number;
  readonly cardHeight: number;
  readonly gap: number;
  readonly padding: number;
  readonly maxWidth: number;
  readonly total: number;
}

export function computeFeedLayout(spec: FeedSpec): GridLayout {
  const { viewportWidth, cardHeight, gap, padding, maxWidth, total } = spec;
  const innerWidth = Math.max(0, viewportWidth - 2 * padding);
  const cellWidth = Math.min(innerWidth, maxWidth);
  const columnStart = padding + Math.floor((innerWidth - cellWidth) / 2);
  const stride = cardHeight + gap;
  const totalHeight = total === 0 ? 0 : 2 * padding + total * stride - gap;
  return { columns: 1, tileSize: cardHeight, cellWidth, rowHeight: stride, rows: total, totalHeight, gap, padding, columnStart, total };
}

export interface VisibleRange {
  readonly firstRow: number;
  readonly lastRow: number;
  /** Photo indices [firstIndex, lastIndex] inclusive; empty when total is 0. */
  readonly firstIndex: number;
  readonly lastIndex: number;
}

const EMPTY_RANGE: VisibleRange = { firstRow: 0, lastRow: -1, firstIndex: 0, lastIndex: -1 };

/** Rows/indices to render for a scroll position, padded by `overscan` rows. */
export function visibleRange(layout: GridLayout, scrollTop: number, viewportHeight: number, overscan: number): VisibleRange {
  if (layout.rows === 0) {
    return EMPTY_RANGE;
  }
  // firstRow clamps to the last row too: a scroll offset past the end of a
  // freshly SHRUNK layout (deep in All → switch to Favorites) must still
  // render the final rows, not an empty window (PR #156 review).
  const firstRow = Math.min(layout.rows - 1, Math.max(0, Math.floor((scrollTop - layout.padding) / layout.rowHeight) - overscan));
  const lastRow = Math.min(
    layout.rows - 1,
    Math.floor((scrollTop - layout.padding + Math.max(0, viewportHeight)) / layout.rowHeight) + overscan,
  );
  return {
    firstRow,
    lastRow,
    firstIndex: firstRow * layout.columns,
    lastIndex: Math.min(layout.total - 1, (lastRow + 1) * layout.columns - 1),
  };
}

/** Absolute position of a tile inside the scrollable content. */
export function tilePosition(layout: GridLayout, index: number): { readonly left: number; readonly top: number } {
  return {
    left: layout.columnStart + (index % layout.columns) * (layout.cellWidth + layout.gap),
    top: layout.padding + Math.floor(index / layout.columns) * layout.rowHeight,
  };
}

/** The top-left visible photo — the anchor preserved across zoom changes. */
export function anchorIndex(layout: GridLayout, scrollTop: number): number | null {
  if (layout.total === 0) {
    return null;
  }
  const row = Math.min(layout.rows - 1, Math.max(0, Math.round((scrollTop - layout.padding) / layout.rowHeight)));
  return Math.min(layout.total - 1, row * layout.columns);
}

/** Scroll position that puts `index`'s row at the top of the viewport. */
export function scrollTopForAnchor(layout: GridLayout, index: number): number {
  const row = Math.floor(Math.min(Math.max(0, index), Math.max(0, layout.total - 1)) / layout.columns);
  return row * layout.rowHeight;
}

/**
 * Prefetch policy: ask for the next page once the rendered window reaches
 * within `prefetchRows` rows of the loaded frontier (and more rows exist).
 */
export function needsMore(layout: GridLayout, range: VisibleRange, loadedCount: number, prefetchRows: number): boolean {
  if (loadedCount >= layout.total || range.lastIndex < 0) {
    return false;
  }
  return range.lastIndex + prefetchRows * layout.columns >= loadedCount;
}
