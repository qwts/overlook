import { useCallback, useEffect, useState } from 'react';

import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { DuplicateResult } from '../../../shared/ipc/variant-channels.js';
import type { PhotoRecord } from '../../../shared/library/types.js';

// The variant family of the Inspector photo (#496, ADR-0031 §1 + §3): every
// live variant over the same original asset and the Promoted representative.
// The family reloads whenever the shown record changes (a page refetch after
// Duplicate replaces it) and on any library change, so a Duplicate from the
// context menu or another window shows up without paging away. Without a
// bridge (Storybook, detached windows before preload) the hook is inert and
// the section stays hidden.

export type PhotoVariantsApi = OverlookApi['variants'];
export type VariantFamilyView = Awaited<ReturnType<PhotoVariantsApi['family']>>;

export interface PhotoVariants {
  readonly family: VariantFamilyView | null;
  readonly busy: boolean;
  /** False when no variants bridge is reachable; the section hides. */
  readonly available: boolean;
  readonly duplicate: () => Promise<DuplicateResult | null>;
  readonly promote: (photoId: string) => Promise<void>;
}

function bridge(): Partial<OverlookApi> | undefined {
  const candidate: unknown = Reflect.get(window, 'overlook');
  return typeof candidate === 'object' && candidate !== null ? candidate : undefined;
}

export function usePhotoVariants(photo: PhotoRecord, api?: PhotoVariantsApi): PhotoVariants {
  const resolvedApi = api ?? bridge()?.variants;
  const [family, setFamily] = useState<VariantFamilyView | null>(null);
  const [busy, setBusy] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const photoId = photo.id;

  useEffect(() => {
    const onChanged = bridge()?.library?.onChanged;
    if (typeof onChanged !== 'function') return;
    return onChanged(() => {
      setEpoch((previous) => previous + 1);
    });
  }, []);

  useEffect(() => {
    if (resolvedApi === undefined) return;
    let active = true;
    void resolvedApi
      .family({ photoId })
      .then((next) => {
        if (active) setFamily(next);
      })
      .catch(() => {
        if (active) setFamily(null);
      });
    return () => {
      active = false;
    };
  }, [photo, photoId, resolvedApi, epoch]);

  const duplicate = useCallback(async () => {
    if (resolvedApi === undefined) return null;
    setBusy(true);
    try {
      const result = await resolvedApi.duplicate({ photoIds: [photoId] });
      setEpoch((previous) => previous + 1);
      return result;
    } catch {
      return null;
    } finally {
      setBusy(false);
    }
  }, [photoId, resolvedApi]);

  const promote = useCallback(
    async (targetId: string) => {
      if (resolvedApi === undefined) return;
      setBusy(true);
      try {
        setFamily(await resolvedApi.promote({ photoId: targetId }));
      } catch {
        // The stored family stays; the next library change reloads it.
      } finally {
        setBusy(false);
      }
    },
    [resolvedApi],
  );

  return { family, busy, available: resolvedApi !== undefined, duplicate, promote };
}
