import { useEffect, useState, useMemo, useCallback } from 'react';

import { useIntl } from 'react-intl';
import { photoKeyMessages } from './photo-command-targets.js';
import { photoCommandAvailability } from '../../../shared/commands/photo-availability.js';
import type { AppState } from '../../../shared/library/app-state.js';
import type { PhotoKeySelection } from '../../../shared/ipc/library-selection-channels.js';

type PhotoKeyState =
  { readonly status: 'loading' } | { readonly status: 'error' } | { readonly status: 'ready'; readonly result: PhotoKeySelection };
export interface PhotoKeyLookup {
  readonly state: PhotoKeyState;
  readonly retry: () => void;
}

/** Key-return/removal events cover offscreen rows too. Never reuse a result for another target set. */
export function usePhotoKeySelection(photoIds: readonly string[]): PhotoKeyLookup {
  const targetKey = JSON.stringify(photoIds);
  const [snapshot, setSnapshot] = useState<{ key: string; state: PhotoKeyState } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setSnapshot(null);
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    if (photoIds.length === 0) return;
    let generation = 0;
    const load = (): void => {
      const request = ++generation;
      void window.overlook.library
        .photoKeySelection({ photoIds: [...photoIds] })
        .then((result) => {
          if (request === generation) setSnapshot({ key: targetKey, state: { status: 'ready', result } });
        })
        .catch(() => {
          if (request === generation) setSnapshot({ key: targetKey, state: { status: 'error' } });
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
  }, [photoIds, targetKey, attempt]);
  return { state: snapshot?.key === targetKey ? snapshot.state : { status: 'loading' }, retry };
}

export function usePhotoKeyTarget(state: Pick<AppState, 'selection' | 'lightboxId'>): boolean {
  const ids = useMemo(() => (state.lightboxId === null ? [...state.selection] : [state.lightboxId]), [state.lightboxId, state.selection]);
  const { state: keys } = usePhotoKeySelection(ids);
  // A failed presentation lookup may retry through the invocation-time query;
  // only that query can open Export. Known locked targets still stay disabled.
  return ids.length > 0 && (keys.status === 'error' || (keys.status === 'ready' && keys.result.photoIds.length > 0));
}

export function useSelectionExportAvailability(selection: ReadonlySet<string>): {
  readonly disabledReason: string | undefined;
  readonly retry: (() => void) | undefined;
} {
  const intl = useIntl();
  const ids = useMemo(() => [...selection], [selection]);
  const { state: keys, retry } = usePhotoKeySelection(ids);
  if (keys.status === 'error') return { disabledReason: intl.formatMessage(photoKeyMessages.unavailable), retry };
  if (keys.status === 'loading') return { disabledReason: intl.formatMessage(photoKeyMessages.checking), retry: undefined };
  const enabled = photoCommandAvailability('photo.export', keys.result.photoIds.length === 0).enabled;
  return {
    disabledReason: enabled
      ? undefined
      : intl.formatMessage(keys.result.locked > 0 ? photoKeyMessages.locked : photoKeyMessages.unavailable),
    retry: undefined,
  };
}
