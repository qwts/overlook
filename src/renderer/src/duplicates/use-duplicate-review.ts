import { useCallback, useEffect, useState } from 'react';

import type { OverlookApi } from '../../../shared/ipc/api.js';

// Perceptual duplicate review (#650): the derived answer from main, reloaded
// whenever the index advances, the library changes (a Trash from this dialog
// or any other surface) or an Original marker moves (#482 — the policy is
// applied at grouping time, so the fresh answer is the only honest one).
// Without a bridge (Storybook, detached windows before preload) the hook is
// inert and reports `available: false`.

export type DuplicatesApi = OverlookApi['duplicates'];
export type DuplicateReviewView = Awaited<ReturnType<DuplicatesApi['review']>>;

export interface DuplicateReview {
  /** False when no duplicates bridge is reachable. */
  readonly available: boolean;
  readonly status: 'loading' | 'ready' | 'failed';
  readonly review: DuplicateReviewView | null;
  readonly rescan: () => Promise<void>;
}

function bridge(): Partial<OverlookApi> | undefined {
  const candidate: unknown = Reflect.get(window, 'overlook');
  return typeof candidate === 'object' && candidate !== null ? candidate : undefined;
}

export function useDuplicateReview(api?: DuplicatesApi): DuplicateReview {
  const resolvedApi = api ?? bridge()?.duplicates;
  const [review, setReview] = useState<DuplicateReviewView | null>(null);
  const [status, setStatus] = useState<DuplicateReview['status']>('loading');
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    const library = bridge()?.library;
    const bump = (): void => {
      setEpoch((previous) => previous + 1);
    };
    const unsubscribers = [
      resolvedApi?.onChanged(bump),
      typeof library?.onChanged === 'function' ? library.onChanged(bump) : undefined,
      typeof library?.onOriginalClassificationChanged === 'function' ? library.onOriginalClassificationChanged(bump) : undefined,
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe?.();
    };
  }, [resolvedApi]);

  useEffect(() => {
    if (resolvedApi === undefined) return;
    let active = true;
    void resolvedApi
      .review()
      .then((next) => {
        if (!active) return;
        setReview(next);
        setStatus('ready');
      })
      .catch(() => {
        if (active) setStatus('failed');
      });
    return () => {
      active = false;
    };
  }, [resolvedApi, epoch]);

  const rescan = useCallback(async () => {
    if (resolvedApi === undefined) return;
    try {
      await resolvedApi.rescan();
    } finally {
      setEpoch((previous) => previous + 1);
    }
  }, [resolvedApi]);

  return { available: resolvedApi !== undefined, status, review, rescan };
}
