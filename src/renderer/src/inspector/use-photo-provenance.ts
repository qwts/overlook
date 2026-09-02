import { useCallback, useEffect, useState } from 'react';

import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { ProvenancePayload } from '../../../shared/ipc/provenance-channels.js';

// Provenance evidence for the Inspector photo (#495, ADR-0031 §5). The
// record loads when the photo changes; main evaluates lazily and locally
// (or reports `deferred` when the original is not local). Re-check forces a
// fresh evaluation. Without a bridge (Storybook, detached windows before
// preload) the hook is inert and the section stays hidden.

export type PhotoProvenanceApi = OverlookApi['provenance'];

export interface PhotoProvenance {
  readonly payload: ProvenancePayload | null;
  readonly busy: boolean;
  /** False when no provenance bridge is reachable; the section hides. */
  readonly available: boolean;
  readonly refresh: () => Promise<void>;
}

function bridge(): Partial<OverlookApi> | undefined {
  const candidate: unknown = Reflect.get(window, 'overlook');
  return typeof candidate === 'object' && candidate !== null ? candidate : undefined;
}

export function usePhotoProvenance(photoId: string, api?: PhotoProvenanceApi): PhotoProvenance {
  const resolvedApi = api ?? bridge()?.provenance;
  const [payload, setPayload] = useState<ProvenancePayload | null>(null);
  // Loading is "no record yet for this photo"; refreshing is tracked apart so
  // the stored record stays on screen while Re-check runs.
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Paging to another photo drops the previous record before its load resolves.
  const [loadedFor, setLoadedFor] = useState(photoId);
  if (loadedFor !== photoId) {
    setLoadedFor(photoId);
    setPayload(null);
    setLoaded(false);
  }

  useEffect(() => {
    if (resolvedApi === undefined) return;
    let active = true;
    void resolvedApi
      .get({ photoId })
      .then((next) => {
        if (active) setPayload(next);
      })
      .catch(() => {
        if (active) setPayload(null);
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [photoId, resolvedApi]);

  const refresh = useCallback(async () => {
    if (resolvedApi === undefined) return;
    setRefreshing(true);
    try {
      setPayload(await resolvedApi.refresh({ photoId }));
    } catch {
      // The stored record stays; the section keeps showing it.
    } finally {
      setRefreshing(false);
    }
  }, [photoId, resolvedApi]);

  return { payload, busy: refreshing || !loaded, available: resolvedApi !== undefined, refresh };
}
