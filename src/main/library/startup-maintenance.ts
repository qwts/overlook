import { CustodyWorkTracker } from '../crypto/library-shutdown.js';

export interface StartupRepairSummary {
  readonly orphanOriginals: readonly unknown[];
  readonly orphanThumbs: readonly unknown[];
  readonly stagedLeftovers: readonly unknown[];
  readonly lyingRows: readonly unknown[];
}

export interface SearchIndexVerification {
  readonly rebuilt: boolean;
}

export interface StartupMaintenanceOptions {
  readonly purge: () => Promise<unknown>;
  readonly repair: () => Promise<StartupRepairSummary> | undefined;
  readonly rawRepair?:
    | (() =>
        Promise<{ readonly scanned: number; readonly repaired: number; readonly failed: number; readonly skipped: number }> | undefined)
    | undefined;
  /** Deterministic video poster capture (ADR-0026 §6) — post-import background
   * work; a miss leaves the placeholder, never a failed import. */
  readonly posterCapture?:
    | (() =>
        Promise<{ readonly scanned: number; readonly captured: number; readonly failed: number; readonly skipped: number }> | undefined)
    | undefined;
  /** FTS5 integrity-check → rebuild-on-failure (#390). Optional — undefined
   * skips it, same convention as `repair` before the library is open. */
  readonly verifySearchIndex?: () => Promise<SearchIndexVerification> | undefined;
  /** All Photos composition flag sweep (#494, ADR-0030 §6): a mismatch is
   * rebuilt from the rows, never trusted. Optional, same convention. */
  readonly verifyAllPhotosFlag?: () => Promise<{ readonly mismatched: number; readonly rebuilt: boolean }> | undefined;
}

export class StartupMaintenance {
  private readonly work = new CustodyWorkTracker();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: StartupMaintenanceOptions) {}

  schedule(): void {
    this.cancel();
    this.timer = setTimeout(() => this.start(), 0);
  }

  cancel(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  drain(): Promise<void> {
    return this.work.drain();
  }

  private start(): void {
    this.timer = undefined;
    void this.work.track(
      this.options.purge().catch((error: unknown) => {
        console.error('[overlook] retention purge failed', error);
      }),
    );

    const repair = this.options.repair();
    if (repair !== undefined) {
      void this.work.track(
        repair
          .then((summary) => {
            const issues =
              summary.orphanOriginals.length + summary.orphanThumbs.length + summary.stagedLeftovers.length + summary.lyingRows.length;
            if (issues > 0) console.warn('[overlook] consistency repair:', JSON.stringify(summary));
          })
          .catch((error: unknown) => {
            console.error('[overlook] consistency check failed', error);
          }),
      );
    }

    const rawRepair = this.options.rawRepair?.();
    if (rawRepair !== undefined) {
      void this.work.track(
        rawRepair
          .then((summary) => {
            if (summary.repaired > 0 || summary.failed > 0) console.info('[overlook] media preview repair:', JSON.stringify(summary));
          })
          .catch((error: unknown) => {
            console.error('[overlook] media preview maintenance failed', error);
          }),
      );
    }

    const posterCapture = this.options.posterCapture?.();
    if (posterCapture !== undefined) {
      void this.work.track(
        posterCapture
          .then((summary) => {
            if (summary.captured > 0 || summary.failed > 0) console.info('[overlook] video poster capture:', JSON.stringify(summary));
          })
          .catch((error: unknown) => {
            console.error('[overlook] video poster capture failed', error);
          }),
      );
    }

    const verifyAllPhotosFlag = this.options.verifyAllPhotosFlag?.();
    if (verifyAllPhotosFlag !== undefined) {
      void this.work.track(
        verifyAllPhotosFlag
          .then((result) => {
            if (result.rebuilt) console.warn(`[overlook] All Photos flag rebuilt for ${String(result.mismatched)} photo(s)`);
          })
          .catch((error: unknown) => {
            console.error('[overlook] All Photos flag verification failed', error);
          }),
      );
    }

    const verifySearchIndex = this.options.verifySearchIndex?.();
    if (verifySearchIndex === undefined) return;
    void this.work.track(
      verifySearchIndex
        .then((result) => {
          if (result.rebuilt) console.warn('[overlook] search index rebuilt after failed integrity check');
        })
        .catch((error: unknown) => {
          console.error('[overlook] search index verification failed', error);
        }),
    );
  }
}
