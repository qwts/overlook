import { useRef, useState } from 'react';

import type { PhotoRecord } from '../../../shared/library/types.js';
import { useAppDispatch } from './app-state-context';

export interface FavoriteMutations {
  readonly pending: ReadonlySet<string>;
  readonly toggleFavorite: (photo: PhotoRecord) => void;
  readonly toggleFavorites: (photoIds: readonly string[]) => void;
}

function availableFavoriteIds(photoIds: readonly string[], pending: ReadonlySet<string>): readonly string[] {
  return photoIds.filter((id) => !pending.has(id));
}

export function useFavoriteMutations(): FavoriteMutations {
  const dispatch = useAppDispatch();
  const pendingRef = useRef<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  const run = (
    photoIds: readonly string[],
    mutation: (activeIds: readonly string[]) => Promise<{ pendingCount: number }>,
    errorTitle: string,
  ): void => {
    const activeIds = availableFavoriteIds(photoIds, pendingRef.current);
    if (activeIds.length === 0) return;
    pendingRef.current = new Set([...pendingRef.current, ...activeIds]);
    setPending(pendingRef.current);
    void mutation(activeIds)
      .then(({ pendingCount }) => dispatch({ type: 'pendingCount/set', count: pendingCount }))
      .catch(() => dispatch({ type: 'toast/shown', toast: { title: errorTitle, tone: 'red' } }))
      .finally(() => {
        const remaining = new Set(pendingRef.current);
        for (const id of activeIds) remaining.delete(id);
        pendingRef.current = remaining;
        setPending(remaining);
      });
  };

  return {
    pending,
    toggleFavorite: (photo) => {
      run([photo.id], () => window.overlook.library.toggleFavorite({ id: photo.id }), `Couldn't update favorite — ${photo.fileName}`);
    },
    toggleFavorites: (photoIds) => {
      run(
        photoIds,
        (activeIds) => window.overlook.library.toggleFavorites({ photoIds: [...activeIds] }),
        "Couldn't update selected favorites",
      );
    },
  };
}
