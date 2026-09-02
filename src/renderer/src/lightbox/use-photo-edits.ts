import { useCallback, useEffect, useState } from 'react';

import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { EditHeadPayload, EditMutationResult } from '../../../shared/ipc/photo-edit-channels.js';
import { IDENTITY_TRANSFORM, operationsFromTransform, type EditTransform } from '../../../shared/library/edit-revision.js';

// The persisted edit head for the lightbox photo (#493, ADR-0031 §2). The
// head loads when the photo changes and again whenever main reports a
// derivative refresh for it (a save from another window, a repair); every
// mutation resolves to the new head so the viewport's draft can settle on it.
// Without a bridge (Storybook, detached windows before preload) the hook is
// inert: identity transform, no head, mutations rejected.

export type PhotoEditApi = OverlookApi['edits'];

export interface PhotoEditState {
  readonly head: EditHeadPayload | null;
  readonly busy: boolean;
}

export interface PhotoEdits {
  readonly state: PhotoEditState;
  /** The head's transform; identity while loading or for the empty root. */
  readonly persisted: EditTransform;
  /** False when no edit bridge is reachable; the viewport hides its controls. */
  readonly available: boolean;
  readonly save: (transform: EditTransform) => Promise<EditMutationResult>;
  readonly reset: () => Promise<EditMutationResult>;
  /** Reverts to the head's parent revision (a new revision, history append-only). */
  readonly revert: () => Promise<EditMutationResult | null>;
}

type LibraryChangeListener = Parameters<OverlookApi['library']['onChanged']>[0];

const IDLE: PhotoEditState = { head: null, busy: false };

function bridge(): Partial<OverlookApi> | undefined {
  const candidate: unknown = Reflect.get(window, 'overlook');
  return typeof candidate === 'object' && candidate !== null ? candidate : undefined;
}

function subscribeLibrary(listener: LibraryChangeListener): () => void {
  const library = bridge()?.library;
  if (library === undefined) return () => undefined;
  return library.onChanged(listener);
}

export function usePhotoEdits(photoId: string, api?: PhotoEditApi): PhotoEdits {
  const resolvedApi = api ?? bridge()?.edits;
  const [state, setState] = useState<PhotoEditState>(IDLE);
  // Paging to another photo drops the previous head before its load resolves.
  const [loadedFor, setLoadedFor] = useState(photoId);
  if (loadedFor !== photoId) {
    setLoadedFor(photoId);
    setState(IDLE);
  }

  useEffect(() => {
    if (resolvedApi === undefined) return;
    let active = true;
    const load = (): void => {
      void resolvedApi
        .head({ photoId })
        .then((head) => {
          if (active) setState((previous) => ({ ...previous, head }));
        })
        .catch(() => {
          if (active) setState((previous) => ({ ...previous, head: null }));
        });
    };
    load();
    const unsubscribe = subscribeLibrary(({ photoIds, derivativeOnly }) => {
      if (derivativeOnly === true && photoIds.includes(photoId)) load();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [photoId, resolvedApi]);

  const mutate = useCallback(
    async (operation: (current: PhotoEditApi) => Promise<EditMutationResult>): Promise<EditMutationResult> => {
      if (resolvedApi === undefined) throw new Error('edits are unavailable without the Overlook bridge');
      setState((previous) => ({ ...previous, busy: true }));
      try {
        const result = await operation(resolvedApi);
        setState({ head: { photoId: result.photoId, head: result.head, history: result.history }, busy: false });
        return result;
      } catch (error) {
        setState((previous) => ({ ...previous, busy: false }));
        throw error;
      }
    },
    [resolvedApi],
  );

  const save = useCallback(
    (transform: EditTransform) => mutate((current) => current.save({ photoId, operations: operationsFromTransform(transform) })),
    [mutate, photoId],
  );
  const reset = useCallback(() => mutate((current) => current.reset({ photoId })), [mutate, photoId]);
  const revert = useCallback(async () => {
    const parentId = state.head?.head?.parentId ?? null;
    if (parentId === null) return null;
    return mutate((current) => current.revert({ photoId, revisionId: parentId }));
  }, [mutate, photoId, state.head]);

  const head = state.head?.head ?? null;
  const persisted = head === null || head.unsupported !== null ? IDENTITY_TRANSFORM : head.transform;
  return { state, persisted, available: resolvedApi !== undefined, save, reset, revert };
}
