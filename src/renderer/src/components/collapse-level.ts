import { useCallback, useLayoutEffect, useState, useSyncExternalStore, type RefObject } from 'react';

/** A lower level must fit with this much room before the element steps
 *  down, so holding the window near a threshold can't flicker between
 *  levels. */
export const COLLAPSE_STEP_DOWN_SPARE_PX = 16;

/** Steps up while the content overflows at the current level, then down
 *  while the next level down fits with spare room. `fits(level, spare)`
 *  reports whether the content fits at `level` with `spare` px left over. */
export function settleCollapseLevel(level: number, maxLevel: number, fits: (level: number, spare: number) => boolean): number {
  let next = Math.min(level, maxLevel);
  while (next < maxLevel && !fits(next, 0)) next += 1;
  while (next > 0 && fits(next - 1, COLLAPSE_STEP_DOWN_SPARE_PX)) next -= 1;
  return next;
}

// Measures the element at a level by setting `data-collapse` (the CSS reads
// it) and `data-collapse-probe`, under which the CSS adds a trailing
// `--collapse-probe`-px item and holds any flexible child at its basis.
function fitsAt(element: HTMLElement, level: number, spare: number): boolean {
  element.dataset['collapse'] = String(level);
  element.dataset['collapseProbe'] = '';
  element.style.setProperty('--collapse-probe', `${spare}px`);
  const fits = element.scrollWidth <= element.clientWidth;
  delete element.dataset['collapseProbe'];
  element.style.removeProperty('--collapse-probe');
  return fits;
}

export interface CollapseLevelOptions {
  /** Runs after each settle with the element that had focus before it, so
   *  a control that just collapsed can hand focus on instead of dropping it
   *  to <body>. */
  readonly onSettle?: (element: HTMLElement, focused: Element | null) => void;
}

// The level is read from layout, so it lives outside React state: a tiny
// store the settle pass writes and the component subscribes to.
interface LevelStore {
  readonly get: () => number;
  readonly set: (level: number) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

function createLevelStore(): LevelStore {
  let level = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => level,
    set: (next) => {
      if (next === level) return;
      level = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Keeps an element's content on one line by stepping through collapse
 *  levels 0…`maxLevel` as its room changes. The element must carry the
 *  returned level as `data-collapse`, and its CSS decides what each level
 *  hides. Shared by the toolbar (#1290) and the selection pill (#1304). */
export function useCollapseLevel(ref: RefObject<HTMLElement>, maxLevel: number, options: CollapseLevelOptions = {}): number {
  const [store] = useState(createLevelStore);
  const level = useSyncExternalStore(store.subscribe, store.get);
  const { onSettle } = options;

  const settle = useCallback((): void => {
    const element = ref.current;
    if (element === null) return;
    const focused = document.activeElement;
    const next = settleCollapseLevel(store.get(), maxLevel, (candidate, spare) => fitsAt(element, candidate, spare));
    element.dataset['collapse'] = String(next);
    onSettle?.(element, focused);
    store.set(next);
  }, [ref, store, maxLevel, onSettle]);

  // Width changes come from the observer; content changes (an action
  // appearing) re-render the owner, so settle after every render too. A
  // settled level re-settles to itself, so this can't loop.
  useLayoutEffect(() => {
    settle();
  });

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    let live = true;
    const settleIfLive = (): void => {
      if (live) settle();
    };
    const observer = new ResizeObserver(settleIfLive);
    observer.observe(element);
    // A content-sized element keeps its box while its container grows, so
    // the container's width is what tells it to step back down.
    if (element.parentElement !== null) observer.observe(element.parentElement);
    // Web fonts change label widths once they load (absent under jsdom).
    if ('fonts' in document) void document.fonts.ready.then(settleIfLive);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [ref, settle]);

  return level;
}
