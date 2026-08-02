import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type { GridLayout } from '../../../shared/library/grid-layout.js';
import { tilePosition } from '../../../shared/library/grid-layout.js';
import { moveGridFocus, type GridNavigationKey } from '../../../shared/library/grid-keyboard.js';

const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

function isNavigationKey(key: string): key is GridNavigationKey {
  return NAVIGATION_KEYS.has(key);
}

interface GridKeyboardOptions<Photo extends { readonly id: string }> {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly photos: readonly Photo[];
  readonly layout: GridLayout;
  readonly viewportHeight: number;
  readonly direction: 'ltr' | 'rtl';
  readonly onOpen?: ((photo: Photo) => void) | undefined;
  readonly onSelection?: ((photoId: string, extend: boolean) => void) | undefined;
  readonly onAnchorChange?: ((photoId: string) => void) | undefined;
  readonly onScrollPositionChange: (scrollTop: number) => void;
}

function gridIndex(target: EventTarget | null): number | null {
  if (!(target instanceof Element) || !target.matches('[data-grid-focus-target="true"]')) return null;
  const value = target.closest<HTMLElement>('[data-grid-index]')?.dataset['gridIndex'];
  if (value === undefined) return null;
  const index = Number(value);
  return Number.isInteger(index) ? index : null;
}

export function useGridKeyboard<Photo extends { readonly id: string }>({
  containerRef,
  photos,
  layout,
  viewportHeight,
  direction,
  onOpen,
  onSelection,
  onAnchorChange,
  onScrollPositionChange,
}: GridKeyboardOptions<Photo>): number {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const shiftNavigationIndexRef = useRef<number | null>(null);
  const activeIndex = Math.min(focusedIndex, Math.max(0, photos.length - 1));

  const focusAt = useCallback(
    (index: number): void => {
      const node = containerRef.current;
      if (node === null || photos.length === 0) return;
      const next = Math.min(photos.length - 1, Math.max(0, index));
      const { top } = tilePosition(layout, next);
      let nextScroll = node.scrollTop;
      if (top < node.scrollTop) nextScroll = top;
      else if (top + layout.tileSize > node.scrollTop + node.clientHeight) nextScroll = top + layout.tileSize - node.clientHeight;
      if (nextScroll !== node.scrollTop) {
        node.scrollTop = nextScroll;
        onScrollPositionChange(nextScroll);
      }
      setFocusedIndex(next);
      requestAnimationFrame(() => {
        containerRef.current?.querySelector<HTMLElement>(`[data-grid-index="${String(next)}"] [data-grid-focus-target="true"]`)?.focus();
      });
    },
    [containerRef, layout, onScrollPositionChange, photos.length],
  );

  useEffect(() => {
    const node = containerRef.current;
    if (node === null) return;
    const onFocusIn = (event: FocusEvent): void => {
      if (event.target === node) {
        shiftNavigationIndexRef.current = null;
        focusAt(activeIndex);
        return;
      }
      const index = gridIndex(event.target);
      if (index !== null) {
        setFocusedIndex(index);
        const photo = photos[index];
        if (photo !== undefined) {
          if (shiftNavigationIndexRef.current === index) shiftNavigationIndexRef.current = null;
          else onAnchorChange?.(photo.id);
        }
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (document.querySelector('[data-testid="lightbox"]') !== null) return;
      const index = gridIndex(event.target);
      const photo = index === null ? undefined : photos[index];
      if (index === null || photo === undefined) return;
      if (event.key === 'Enter') onOpen?.(photo);
      else if (event.key === ' ') {
        onSelection?.(photo.id, event.shiftKey);
      } else if (isNavigationKey(event.key)) {
        const next = moveGridFocus({
          key: event.key,
          index,
          count: photos.length,
          columns: Math.max(1, layout.columns),
          pageRows: Math.max(1, Math.floor(viewportHeight / Math.max(1, layout.rowHeight))),
          direction,
        });
        focusAt(next);
        const nextPhoto = photos[next];
        if (nextPhoto !== undefined) {
          if (event.shiftKey) {
            shiftNavigationIndexRef.current = next;
            onSelection?.(nextPhoto.id, true);
          } else {
            shiftNavigationIndexRef.current = null;
            onAnchorChange?.(nextPhoto.id);
          }
        }
      } else return;
      event.preventDefault();
      event.stopPropagation();
    };
    node.addEventListener('focusin', onFocusIn);
    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('focusin', onFocusIn);
      node.removeEventListener('keydown', onKeyDown);
    };
  }, [activeIndex, containerRef, direction, focusAt, layout, onAnchorChange, onOpen, onSelection, photos, viewportHeight]);

  return activeIndex;
}
