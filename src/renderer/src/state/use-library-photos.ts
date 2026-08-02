import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChipFilters, PageCursor, PageRequest, SyncStatus } from '../../../shared/library/types.js';
import { useAppState, useAppDispatch } from './app-state-context';

const PAGE_SIZE = 500; // channel max — fewest round-trips on deep scrolls

export const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function recentSinceIso(): string {
  return new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
}

function chipsActive(chips: ChipFilters): boolean {
  return Object.values(chips).some(Boolean);
}

function membershipChanged(
  membership: 'none' | 'favorite' | 'album' | 'library' | undefined,
  source: PageRequest['source'],
  chips: ChipFilters,
  album: string | null,
): boolean {
  if (membership === undefined) return false;
  if (membership === 'none') return false;
  if (membership === 'favorite') return source === 'favorites' || chips.favorites === true;
  if (membership === 'album') return album !== null;
  return true;
}

function useSyncStatePatches(localOnly: boolean, fetchFirstPage: (preserveSelection?: boolean) => void): void {
  const dispatch = useAppDispatch();
  useEffect(() => {
    const pending = new Map<string, SyncStatus>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      timer = null;
      if (localOnly) {
        pending.clear();
        fetchFirstPage(false);
        return;
      }
      const updates = [...pending].map(([id, syncState]) => ({ id, syncState }));
      pending.clear();
      if (updates.length > 0) {
        dispatch({ type: 'photos/sync-state-patched', updates });
      }
    };
    const unsubscribe = window.overlook.library.onSyncStateChanged(({ updates }) => {
      for (const update of updates) {
        pending.set(update.id, update.syncState);
      }
      if (timer === null) {
        timer = setTimeout(flush, 50);
      }
    });
    return () => {
      unsubscribe();
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [dispatch, fetchFirstPage, localOnly]);
}

// Data windowing for the grid engine (#74): first page per visible set
// (source + query + chips, #76), cursor pages on demand. Stale-cancel: any
// visible-set change bumps the request id, so a late response from the
// previous set is dropped instead of appended. `exhausted` tells the grid
// the loaded count IS the filtered total (counts can't answer for filters).
export function useLibraryPhotos(): { readonly loadMore: () => void; readonly exhausted: boolean } {
  const { source, query, chips, sortOrder, album } = useAppState();
  const dispatch = useAppDispatch();
  const cursorRef = useRef<PageCursor | null>(null);
  const requestRef = useRef(0);
  const inFlightRef = useRef(false);
  // Exhaustion is keyed to the visible set: switching sets changes the key,
  // which resets `exhausted` derivationally (no setState-in-effect).
  const setKey = `${source}|${query}|${JSON.stringify(chips)}|${sortOrder}|${album ?? ''}`;
  const [exhaustedKey, setExhaustedKey] = useState<string | null>(null);
  const exhausted = exhaustedKey === setKey;

  const baseRequest = useCallback(
    (): Omit<PageRequest, 'cursor'> => ({
      source,
      limit: PAGE_SIZE,
      ...(source === 'recent' ? { recentSince: recentSinceIso() } : {}),
      ...(query === '' ? {} : { query }),
      ...(chipsActive(chips) ? { chips } : {}),
      ...(sortOrder === 'date' ? {} : { order: sortOrder }),
      ...(album === null ? {} : { albumId: album }),
    }),
    [source, query, chips, sortOrder, album],
  );

  const fetchFirstPage = useCallback(
    (preserveSelection = true) => {
      const requestId = (requestRef.current += 1);
      inFlightRef.current = true;
      cursorRef.current = null;
      void window.overlook.library
        .page(baseRequest())
        .then(({ photos, nextCursor }) => {
          if (requestRef.current !== requestId) {
            return;
          }
          cursorRef.current = nextCursor;
          setExhaustedKey(nextCursor === null ? setKey : null);
          dispatch({ type: 'photos/loaded', photos, append: false, preserveSelection });
        })
        .finally(() => {
          if (requestRef.current === requestId) {
            inFlightRef.current = false;
          }
        });
    },
    [baseRequest, setKey, dispatch],
  );

  useEffect(() => {
    fetchFirstPage();
  }, [fetchFirstPage]);

  // Library mutations refetch the visible page too (PR #167 review): a
  // favorite toggle while viewing Favorites must add/remove the row, not
  // leave stale cells or permanent loading placeholders. Replace semantics
  // reset the cursor; the selection intersects safely in the reducer.
  useEffect(() => {
    return window.overlook.library.onChanged(({ photoIds, derivativeOnly, membership }) => {
      // A derivative can change in place (video poster captured post-import, a
      // repaired RAW preview) without altering the record or its stable thumb
      // URL — so bump those ids' cache-bust epoch to force the tiles to reload.
      dispatch({ type: 'thumbs/invalidated', photoIds });
      // A derivative-only change must NOT refetch the page: replacing the
      // loaded window would reset scroll and drop the lightbox/selection for
      // items beyond page 1 (#744 review). Only membership/metadata changes do.
      if (derivativeOnly !== true) fetchFirstPage(!membershipChanged(membership, source, chips, album));
    });
  }, [album, chips, dispatch, fetchFirstPage, source]);

  // Backup changes only syncState, so patch loaded records instead of
  // replacing the first page (which used to flicker, trim deep selection,
  // and close the lightbox on every uploaded photo). A short window folds
  // bursty providers into one render. Status-filtered views are the
  // exception because offload/restore changes their query membership.
  const statusFiltered = source === 'offloaded' || chips.localOnly === true || chips.offloaded === true;
  useSyncStatePatches(statusFiltered, fetchFirstPage);

  const loadMore = useCallback(() => {
    const cursor = cursorRef.current;
    if (inFlightRef.current || cursor === null) {
      return;
    }
    const requestId = requestRef.current;
    inFlightRef.current = true;
    void window.overlook.library
      .page({ ...baseRequest(), cursor })
      .then(({ photos, nextCursor }) => {
        if (requestRef.current !== requestId) {
          return;
        }
        cursorRef.current = nextCursor;
        setExhaustedKey(nextCursor === null ? setKey : null);
        dispatch({ type: 'photos/loaded', photos, append: true });
      })
      .finally(() => {
        if (requestRef.current === requestId) {
          inFlightRef.current = false;
        }
      });
  }, [baseRequest, setKey, dispatch]);

  return { loadMore, exhausted };
}
