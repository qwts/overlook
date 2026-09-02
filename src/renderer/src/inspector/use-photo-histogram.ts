import { useEffect, useState } from 'react';

import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { HistogramReady, HistogramUnavailable } from '../../../shared/ipc/histogram-channels.js';

// The Inspector photo's histogram (#498): main bins the photo's own mid
// derivative (edits baked in) off its main thread; the renderer only asks
// and draws. The answer reloads whenever the library reports a change to
// this photo — a saved edit re-bakes the derivative, a repair replaces it —
// and the previous answer stays on screen for the same photo while the
// next one computes, so paging never flickers to an empty chart. Without
// a bridge (Storybook, detached windows before preload) the hook is inert
// and the section hides.

export type PhotoHistogramApi = OverlookApi['histogram'];

export type HistogramView =
  | { readonly status: 'computing' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly payload: HistogramReady }
  | { readonly status: 'unavailable'; readonly payload: HistogramUnavailable };

export interface PhotoHistogram {
  /** False when no histogram bridge is reachable; the section hides. */
  readonly available: boolean;
  readonly view: HistogramView;
}

interface Answer {
  readonly photoId: string;
  readonly view: HistogramView;
}

const COMPUTING: HistogramView = { status: 'computing' };

function bridge(): Partial<OverlookApi> | undefined {
  const candidate: unknown = Reflect.get(window, 'overlook');
  return typeof candidate === 'object' && candidate !== null ? candidate : undefined;
}

export function usePhotoHistogram(photoId: string, api?: PhotoHistogramApi): PhotoHistogram {
  const resolvedApi = api ?? bridge()?.histogram;
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    const onChanged = bridge()?.library?.onChanged;
    if (typeof onChanged !== 'function') return;
    return onChanged(({ photoIds }) => {
      if (photoIds.includes(photoId)) setEpoch((previous) => previous + 1);
    });
  }, [photoId]);

  useEffect(() => {
    if (resolvedApi === undefined) return;
    let active = true;
    void resolvedApi
      .get({ photoId })
      .then((payload) => {
        if (!active) return;
        setAnswer({ photoId, view: payload.state === 'ready' ? { status: 'ready', payload } : { status: 'unavailable', payload } });
      })
      .catch(() => {
        if (active) setAnswer({ photoId, view: { status: 'failed' } });
      });
    return () => {
      active = false;
    };
  }, [epoch, photoId, resolvedApi]);

  return {
    available: resolvedApi !== undefined,
    view: answer !== null && answer.photoId === photoId ? answer.view : COMPUTING,
  };
}
