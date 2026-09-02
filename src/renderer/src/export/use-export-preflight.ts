import { useEffect, useState } from 'react';

import type { ExportPayloadMode } from '../../../shared/ipc/export-channels.js';

// #497 (ADR-0031 §6): before bytes leave custody the dialog asks main what
// the chosen mode does to the selection's edits. Null while loading or when
// the destination cannot carry edits (Apple Photos receives originals).

export interface ExportEditLoss {
  readonly photoId: string;
  readonly fileName: string;
  readonly reason: string;
}

export interface ExportPreflightReport {
  readonly edited: number;
  readonly losses: readonly ExportEditLoss[];
}

interface Answer {
  readonly request: string;
  readonly report: ExportPreflightReport;
}

export function useExportPreflight(
  photoIds: readonly string[],
  allPhotos: boolean,
  mode: ExportPayloadMode,
  enabled: boolean,
): ExportPreflightReport | null {
  const ids = photoIds.join(' ');
  const request = `${allPhotos ? 'all' : 'selected'}:${mode}:${ids}`;
  const [answer, setAnswer] = useState<Answer | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void window.overlook.export
      .preflight(allPhotos ? { mode } : { photoIds: ids === '' ? [] : ids.split(' '), mode })
      .then((report) => {
        if (live) setAnswer({ request, report });
      })
      .catch(() => {
        if (live) setAnswer({ request, report: { edited: 0, losses: [] } });
      });
    return () => {
      live = false;
    };
  }, [allPhotos, enabled, ids, mode, request]);
  // A stale answer (another mode or selection) never gates the current one.
  return enabled && answer !== null && answer.request === request ? answer.report : null;
}
