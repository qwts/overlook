// M11 perf budgets (#123) — RATCHETS: tighten when the numbers improve,
// never loosen. The written source of truth is the wiki Testing-Strategy
// §Perf budgets; this file is what the harness enforces. Baselined on the
// 200K synthetic profile (see the wiki table for the recorded numbers and
// the machine caveat). Scroll drop rate is the median of three visible-window
// trials; the worst-frame ceiling applies to the maximum across those trials.

import type { ScrollStats } from './scroll-stats.js';

export const BUDGETS = {
  /** Launch → an EXISTING 200K library's grid interactive (the harness
   * seeds on a prior untimed run). */
  coldStartMs: 5_000,
  /** Median keyset page of 500 over IPC. */
  page500Ms: 250,
  /** Median sidebar counts over IPC — one FILTER-clause pass over the
   * ledger join (#124 tightened this from 1000: 689ms → 378ms measured). */
  countsMs: 500,
  /** Median substring search page over IPC. */
  searchMs: 600,
  /** ADR-0018: text embedding + 200K cosine KNN + RRF + hydration over IPC. */
  semanticSearchMs: 900,
  /** Dropped-frame share during sustained scroll, any zoom. Zoom 96 is
   * the pressure point (most tiles/viewport — image-decode churn); #124
   * owns driving this ratchet toward 0.1. */
  scrollDropRate: 0.3,
  /** Worst frame-to-frame delta during scroll, ms. */
  scrollWorstMs: 500,
  /** Full-pipeline import floor (copy + encrypt + record + thumbs). */
  importPhotosPerSecMin: 3,
  /** Main-process RSS ceiling after the workout, MB. */
  mainRssMbMax: 1_500,
  /** Renderer JS heap ceiling after the workout, MB. */
  rendererHeapMbMax: 512,
} as const;

export interface PerfReport {
  readonly librarySize: number;
  readonly coldStartMs: number;
  readonly page500Ms: number;
  readonly countsMs: number;
  readonly searchMs: number;
  readonly semanticSearchMs: number;
  readonly scroll: Record<'zoom96' | 'zoom160' | 'zoom320', ScrollStats>;
  readonly importPhotosPerSec: number;
  readonly mainRssMb: number;
  readonly rendererHeapMb: number;
}
