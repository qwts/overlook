import { useRef, useState } from 'react';

import type { PhotoRecord } from '../../../shared/library/types.js';
import { useAppDispatch } from './app-state-context';

export interface FavoriteMutations {
  readonly pending: ReadonlySet<string>;
  readonly toggleFavorite: (photo: PhotoRecord) => void;
  readonly toggleFavorites: (photoIds: readonly string[]) => void;
}

export function useFavoriteMutations(): FavoriteMutations {
  const dispatch = useAppDispatch();
  const pendingRef = useRef<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  const run = (photoIds: readonly string[], mutation: () => Promise<{ pendingCount: number }>, errorTitle: string): void => {
    const activeIds = photoIds.filter((id) => !pendingRef.current.has(id));
    if (activeIds.length === 0) return;
    pendingRef.current = new Set([...pendingRef.current, ...activeIds]);
    setPending(pendingRef.current);
    void mutation()
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
      run(photoIds, () => window.overlook.library.toggleFavorites({ photoIds: [...photoIds] }), "Couldn't update selected favorites");
    },
  };
}
