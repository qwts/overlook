import { useCallback, useLayoutEffect, useState, useSyncExternalStore, type RefObject } from 'react';

/** Collapse levels (#1290, Pass B spec §02), applied in this order and never
 *  another: 1 zoom slider → Zoom button, 2 wordmark text hides, 3 Import goes
 *  icon-only, 4 view Segmented → View menu button. */
export type ToolbarCollapseLevel = 0 | 1 | 2 | 3 | 4;

export const MAX_COLLAPSE_LEVEL: ToolbarCollapseLevel = 4;

/** A lower level must fit with this much room before the row steps down, so
 *  holding the window near a threshold can't flicker between levels. */
export const COLLAPSE_STEP_DOWN_SPARE_PX = 16;

/** Steps up while the row overflows at the current level, then down while
 *  the next level down fits with spare room. `fits(level, spare)` reports
 *  whether the row's content fits at `level` with `spare` px left over. */
export function settleCollapseLevel(
  level: ToolbarCollapseLevel,
  fits: (level: ToolbarCollapseLevel, spare: number) => boolean,
): ToolbarCollapseLevel {
  let next = level;
  while (next < MAX_COLLAPSE_LEVEL && !fits(next, 0)) next = (next + 1) as ToolbarCollapseLevel;
  while (next > 0 && fits((next - 1) as ToolbarCollapseLevel, COLLAPSE_STEP_DOWN_SPARE_PX)) next = (next - 1) as ToolbarCollapseLevel;
  return next;
}

// Measures the row at a level by setting `data-collapse` (the CSS reads it)
// and `data-collapse-probe`, which holds the search field at its 300px basis
// and adds a trailing `spare`-px item. The toolbar collapses before the
// search field shrinks; only at level 4, with nothing left to collapse, does
// the field give way toward its minimum.
function rowFits(row: HTMLElement, level: ToolbarCollapseLevel, spare: number): boolean {
  row.dataset['collapse'] = String(level);
  row.dataset['collapseProbe'] = '';
  row.style.setProperty('--toolbar-collapse-probe', `${spare}px`);
  const fits = row.scrollWidth <= row.clientWidth;
  delete row.dataset['collapseProbe'];
  row.style.removeProperty('--toolbar-collapse-probe');
  return fits;
}

function isRendered(element: Element): boolean {
  return element.getClientRects().length > 0;
}

// A control that just collapsed hands focus to its replacement in the same
// slot (slider ↔ Zoom button, Segmented ↔ View menu button), so focus never
// falls to <body>. A radio group hands it to its checked radio.
function moveFocusToReplacement(row: HTMLElement, focused: Element | null): void {
  if (!(focused instanceof HTMLElement) || !row.contains(focused) || isRendered(focused)) return;
  const slot = focused.closest<HTMLElement>('[data-collapse-slot]')?.dataset['collapseSlot'];
  if (slot === undefined) return;
  const replacement = Array.from(row.querySelectorAll<HTMLElement>(`[data-collapse-slot="${slot}"]`)).find(isRendered);
  const target =
    replacement?.querySelector<HTMLElement>('[aria-checked="true"]') ??
    replacement?.querySelector<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])');
  target?.focus();
}

function settleRow(row: HTMLElement, current: ToolbarCollapseLevel): ToolbarCollapseLevel {
  const focused = document.activeElement;
  const next = settleCollapseLevel(current, (candidate, spare) => rowFits(row, candidate, spare));
  row.dataset['collapse'] = String(next);
  moveFocusToReplacement(row, focused);
  return next;
}

// The level is read from layout, so it lives outside React state: a tiny
// store the settle pass writes and the toolbar subscribes to.
interface LevelStore {
  readonly get: () => ToolbarCollapseLevel;
  readonly set: (level: ToolbarCollapseLevel) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

function createLevelStore(): LevelStore {
  let level: ToolbarCollapseLevel = 0;
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

/** Keeps the toolbar row on one line by stepping through the collapse
 *  levels as its width changes (#1290). The row must carry the returned
 *  level as `data-collapse`. */
export function useToolbarCollapse(rowRef: RefObject<HTMLElement>): ToolbarCollapseLevel {
  const [store] = useState(createLevelStore);
  const level = useSyncExternalStore(store.subscribe, store.get);

  const settle = useCallback((): void => {
    const row = rowRef.current;
    if (row !== null) store.set(settleRow(row, store.get()));
  }, [rowRef, store]);

  // Width changes come from the observer; content changes (Back up or Lock
  // appearing) re-render the toolbar, so settle after every render too. A
  // settled level re-settles to itself, so this can't loop. Settling changes
  // only the row's children, never the row's own box, so the observer can't
  // feed back into itself either.
  useLayoutEffect(() => {
    settle();
  });

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row === null || typeof ResizeObserver === 'undefined') return;
    let live = true;
    const settleIfLive = (): void => {
      if (live) settle();
    };
    const observer = new ResizeObserver(settleIfLive);
    observer.observe(row);
    // Web fonts change label widths once they load.
    void document.fonts.ready.then(settleIfLive);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [rowRef, settle]);

  return level;
}
