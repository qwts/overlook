import { useEffect, useState, useMemo } from 'react';

import { useIntl } from 'react-intl';
import { photoKeyMessages } from './photo-command-targets.js';
import { photoCommandAvailability } from '../../../shared/commands/photo-availability.js';
import type { AppState } from '../../../shared/library/app-state.js';
import type { PhotoKeySelection } from '../../../shared/ipc/library-selection-channels.js';

/** Key-return/removal events cover offscreen rows too. Never reuse a result for another target set. */
export function usePhotoKeySelection(photoIds: readonly string[]): PhotoKeySelection | null {
  const targetKey = JSON.stringify(photoIds);
  const [snapshot, setSnapshot] = useState<{ key: string; result: PhotoKeySelection } | null>(null);
  useEffect(() => {
    if (photoIds.length === 0) return;
    let generation = 0;
    const load = (): void => {
      const request = ++generation;
      void window.overlook.library
        .photoKeySelection({ photoIds: [...photoIds] })
        .then((result) => {
          if (request === generation) setSnapshot({ key: targetKey, result });
        })
        .catch(() => {
          if (request === generation) setSnapshot(null);
        });
    };
    load();
    const targets = new Set(photoIds);
    const unsubscribe = window.overlook.library.onChanged(({ derivativeOnly, photoIds: changedIds }) => {
      if (derivativeOnly !== true && (changedIds.length === 0 || changedIds.some((id) => targets.has(id)))) {
        setSnapshot(null);
        load();
      }
    });
    return () => {
      generation++;
      unsubscribe();
    };
  }, [photoIds, targetKey]);
  return snapshot?.key === targetKey ? snapshot.result : null;
}

export function usePhotoKeyTarget(state: Pick<AppState, 'selection' | 'lightboxId'>): boolean {
  const ids = useMemo(() => (state.lightboxId === null ? [...state.selection] : [state.lightboxId]), [state.lightboxId, state.selection]);
  return (usePhotoKeySelection(ids)?.photoIds.length ?? 0) > 0;
}

export function useSelectionExportReason(selection: ReadonlySet<string>): string | undefined {
  const intl = useIntl();
  const ids = useMemo(() => [...selection], [selection]);
  const keys = usePhotoKeySelection(ids);
  if (keys === null) return intl.formatMessage(photoKeyMessages.checking);
  if (photoCommandAvailability('photo.export', keys.photoIds.length === 0).enabled) return undefined;
  return intl.formatMessage(keys.locked > 0 ? photoKeyMessages.locked : photoKeyMessages.unavailable);
}
