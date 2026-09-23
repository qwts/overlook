import { useEffect, useState } from 'react';
import type { PhotoRecord } from '../../../shared/library/types.js';

type Selection = { readonly photoId: string | null };

/** A detached window owns its record cache and must follow main-process changes. */
export function useDetachedInspectorPhoto(selection: Selection): PhotoRecord | null {
  const [snapshot, setSnapshot] = useState<{ selection: Selection; photo: PhotoRecord | null } | null>(null);
  useEffect(() => {
    const id = selection.photoId;
    if (id === null) return;
    let active = true;
    let generation = 0;
    const load = (): void => {
      const request = ++generation;
      void window.overlook.library
        .get({ id })
        .then(({ photo }) => {
          if (active && request === generation) setSnapshot({ selection, photo });
        })
        .catch(() => {
          if (active && request === generation) setSnapshot({ selection, photo: null });
        });
    };
    const unsubscribe = window.overlook.library.onChanged(({ photoIds }) => {
      if (photoIds.length === 0 || photoIds.includes(id)) load();
    });
    load();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [selection]);
  return snapshot?.selection === selection ? snapshot.photo : null;
}
