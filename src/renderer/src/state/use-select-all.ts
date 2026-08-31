import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

import type { LibraryQuery } from '../../../shared/library/types.js';
import { useAppDispatch, useAppState } from './app-state-context';
import { RECENT_WINDOW_MS } from './use-library-photos';

function recentSinceIso(): string {
  return new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
}

function hasActiveChips(chips: LibraryQuery['chips']): boolean {
  return Object.values(chips ?? {}).some(Boolean);
}

/** Resolves Select All against the complete current collection, not loaded rows. */
export function useSelectAll(): () => void {
  const { source, query, searchMode, search, chips, sortOrder, album, protectedAlbum, selectionRevision } = useAppState();
  const dispatch = useAppDispatch();
  const requestRef = useRef(0);
  const scopeKeyRef = useRef('');
  const selectionIntentKeyRef = useRef('');
  const request = useMemo<LibraryQuery>(
    () => ({
      source,
      ...(source === 'recent' ? { recentSince: recentSinceIso() } : {}),
      ...(query === '' ? {} : { query }),
      searchMode,
      ...(query === '' ? {} : { searchProjection: search.appliedMode }),
      ...(hasActiveChips(chips) ? { chips } : {}),
      ...(sortOrder === 'date' ? {} : { order: sortOrder }),
      ...(album === null ? {} : { albumId: album }),
    }),
    [album, chips, query, search.appliedMode, searchMode, sortOrder, source],
  );
  const scopeKey = JSON.stringify(request);
  useLayoutEffect(() => {
    scopeKeyRef.current = scopeKey;
    selectionIntentKeyRef.current = String(selectionRevision);
  }, [scopeKey, selectionRevision]);

  return useCallback(() => {
    if (protectedAlbum !== null) return;
    const requestId = (requestRef.current += 1);
    const requestedScope = scopeKey;
    const requestedSelectionIntent = String(selectionRevision);
    void window.overlook.library
      .selectAll(request)
      .then(({ photoIds }) => {
        if (
          requestRef.current !== requestId ||
          scopeKeyRef.current !== requestedScope ||
          selectionIntentKeyRef.current !== requestedSelectionIntent
        )
          return;
        dispatch({ type: 'selection/all', photoIds: [...new Set(photoIds)] });
      })
      .catch(() => {
        if (
          requestRef.current !== requestId ||
          scopeKeyRef.current !== requestedScope ||
          selectionIntentKeyRef.current !== requestedSelectionIntent
        )
          return;
        dispatch({ type: 'toast/shown', toast: { title: 'Could not select all photos', tone: 'red' } });
      });
  }, [dispatch, protectedAlbum, request, scopeKey, selectionRevision]);
}
