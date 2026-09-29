import type { RefObject } from 'react';
import { useCollapseLevel } from '../components/collapse-level';

/** Collapse levels (#1290, Pass B spec §02), applied in this order and never
 *  another: 1 zoom slider → Zoom button, 2 wordmark text hides, 3 Import goes
 *  icon-only, 4 view Segmented → View menu button. The search field keeps
 *  its basis while measuring (shell.css), so the toolbar collapses before it
 *  shrinks; only at level 4 does the field give way toward its minimum. */
export type ToolbarCollapseLevel = 0 | 1 | 2 | 3 | 4;

export const MAX_COLLAPSE_LEVEL: ToolbarCollapseLevel = 4;

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

const TOOLBAR_COLLAPSE = { onSettle: moveFocusToReplacement } as const;

/** Keeps the toolbar row on one line by stepping through the collapse
 *  levels as its width changes (#1290). The row must carry the returned
 *  level as `data-collapse`. */
export function useToolbarCollapse(rowRef: RefObject<HTMLElement>): ToolbarCollapseLevel {
  return useCollapseLevel(rowRef, MAX_COLLAPSE_LEVEL, TOOLBAR_COLLAPSE) as ToolbarCollapseLevel;
}
