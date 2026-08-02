import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useIntl } from 'react-intl';

import './grid.css';
import {
  anchorIndex,
  computeLayout,
  computeListLayout,
  needsMore,
  scrollTopForAnchor,
  tilePosition,
  visibleRange,
} from '../../../shared/library/grid-layout.js';
import { createFrameMonitor } from './frame-monitor';
import { directionOf } from '../../../shared/i18n/locales.js';
import { useGridKeyboard } from './use-grid-keyboard';

const GRID_GAP = 4; // must equal --grid-gap (spacing tokens)
const LIST_ROW_HEIGHT = 52; // mock ListRow height
const LIST_GAP = 2; // mock list column gap
const LIST_PADDING = 8; // --space-3, the mock's list padding
const OVERSCAN_ROWS = 2;
const PREFETCH_ROWS = 6;
/** Scroll idle window after which the frame monitor detaches. */
const SCROLL_IDLE_MS = 200;

export interface VirtualGridProps<Photo extends { readonly id: string }> {
  readonly photos: readonly Photo[];
  /** Total photos in the active source — sizes the scroll plane. */
  readonly total: number;
  readonly zoom: number;
  /** 'grid' (default) or the dense single-column 'list' mode (#77). */
  readonly mode?: 'grid' | 'list' | undefined;
  readonly topInset?: boolean | undefined;
  /** Ask the data layer for the next cursor page (idempotent under spam). */
  readonly onNeedMore: () => void;
  /** Tile renderer — #74 ships a placeholder; #76 swaps in PhotoTile. */
  readonly renderTile?: ((photo: Photo, size: number, keyboard: VirtualGridItemKeyboard) => ReactNode) | undefined;
  readonly onKeyboardOpen?: ((photo: Photo) => void) | undefined;
  readonly onKeyboardSelection?: ((photoId: string, extend: boolean) => void) | undefined;
  readonly onSelectionAnchorChange?: ((photoId: string) => void) | undefined;
}

export interface VirtualGridItemKeyboard {
  readonly tabIndex: 0 | -1;
  readonly gridFocusTarget: true;
}

// Windowed rendering engine (#74): absolute-positioned tiles over an exact
// scroll plane from grid-layout math. Only the visible window (+overscan)
// mounts; scroll and resize drive state through rAF-throttled handlers.
export function VirtualGrid<Photo extends { readonly id: string }>({
  photos,
  total,
  zoom,
  mode = 'grid',
  topInset = false,
  onNeedMore,
  renderTile,
  onKeyboardOpen,
  onKeyboardSelection,
  onSelectionAnchorChange,
}: VirtualGridProps<Photo>): ReactElement {
  const intl = useIntl();
  const direction = directionOf(intl.locale);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);

  const layout = useMemo(
    () =>
      mode === 'list'
        ? computeListLayout({ viewportWidth: viewport.width, rowHeight: LIST_ROW_HEIGHT, gap: LIST_GAP, padding: LIST_PADDING, total })
        : computeLayout({ viewportWidth: viewport.width, zoom, gap: GRID_GAP, total }),
    [viewport.width, zoom, mode, total],
  );

  // Viewport tracking: ResizeObserver keeps the math honest on window and
  // inspector-panel resizes.
  useLayoutEffect(() => {
    const node = containerRef.current;
    if (node === null) {
      return;
    }
    const measure = (): void => {
      setViewport({ width: node.clientWidth, height: node.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Zoom anchor restoration: before the layout for a new zoom paints, move
  // the scroll position so the previous top-left photo stays visible.
  const prevLayoutRef = useRef(layout);
  useLayoutEffect(() => {
    const node = containerRef.current;
    const prev = prevLayoutRef.current;
    prevLayoutRef.current = layout;
    if (node === null || prev === layout || prev.tileSize === layout.tileSize) {
      return;
    }
    const anchor = anchorIndex(prev, node.scrollTop);
    if (anchor !== null) {
      const restored = scrollTopForAnchor(layout, anchor);
      node.scrollTop = restored;
      setScrollTop(restored);
    }
  }, [layout]);

  // rAF-throttled scroll → state, with the frame monitor attached only while
  // scrolling (M11 budget instrumentation).
  const monitorRef = useRef(createFrameMonitor());
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frameRef = useRef(0);
  const onScroll = useCallback(() => {
    const node = containerRef.current;
    if (node === null) {
      return;
    }
    monitorRef.current.start();
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      monitorRef.current.stop();
    }, SCROLL_IDLE_MS);
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      setScrollTop(node.scrollTop);
    });
  }, []);
  useEffect(() => {
    const monitor = monitorRef.current;
    return () => {
      cancelAnimationFrame(frameRef.current);
      clearTimeout(idleTimerRef.current);
      monitor.stop();
    };
  }, []);

  const range = visibleRange(layout, scrollTop, viewport.height, OVERSCAN_ROWS);

  const activeFocusedIndex = useGridKeyboard({
    containerRef,
    photos,
    layout,
    viewportHeight: viewport.height,
    direction,
    onOpen: onKeyboardOpen,
    onSelection: onKeyboardSelection,
    onAnchorChange: onSelectionAnchorChange,
    onScrollPositionChange: setScrollTop,
  });

  // Data windowing: request the next cursor page as the window nears the
  // loaded frontier. The parent guards in-flight/stale requests.
  useEffect(() => {
    if (needsMore(layout, range, photos.length, PREFETCH_ROWS)) {
      onNeedMore();
    }
  }, [layout, range, photos.length, onNeedMore]);

  const tiles: ReactNode[] = [];
  for (let index = range.firstIndex; index <= range.lastIndex; index += 1) {
    const photo = photos[index];
    const { left: logicalLeft, top } = tilePosition(layout, index);
    const left = direction === 'rtl' ? viewport.width - logicalLeft - layout.cellWidth : logicalLeft;
    tiles.push(
      <div
        key={index}
        className="ovl-grid__cell"
        role="listitem"
        aria-posinset={index + 1}
        aria-setsize={total}
        aria-busy={photo === undefined ? true : undefined}
        data-index={index}
        data-grid-index={index}
        style={{ transform: `translate(${left}px, ${top}px)`, width: layout.cellWidth, height: layout.tileSize }}
      >
        {photo !== undefined && renderTile !== undefined ? (
          renderTile(photo, layout.tileSize, {
            tabIndex: activeFocusedIndex === index ? 0 : -1,
            gridFocusTarget: true,
          })
        ) : (
          <div className={`ovl-grid__placeholder${photo === undefined ? ' ovl-grid__placeholder--loading' : ''}`} />
        )}
      </div>,
    );
  }

  return (
    <div
      ref={containerRef}
      id="photo-grid"
      role="list"
      aria-label={intl.formatMessage({ id: 'grid.regionLabel', defaultMessage: 'Photos' })}
      tabIndex={-1}
      className={`ovl-grid${topInset ? ' ovl-grid--inset' : ''}`}
      data-testid="virtual-grid"
      onScroll={onScroll}
    >
      <div className="ovl-grid__plane" style={{ height: layout.totalHeight }}>
        {tiles}
      </div>
    </div>
  );
}
