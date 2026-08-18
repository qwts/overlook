import { useEffect, useState } from 'react';

import type { PhotoCustodyStatus } from '../../../shared/backup/custody-status.js';

export function usePhotoCustodyStatus(photoId: string, enabled: boolean): PhotoCustodyStatus | null {
  const [loaded, setLoaded] = useState<{ readonly photoId: string; readonly status: PhotoCustodyStatus } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const load = (): void => {
      void window.overlook.backup
        .photoCustodyStatus({ photoId })
        .then((next) => {
          if (active) setLoaded({ photoId, status: next });
        })
        .catch(() => {
          if (active) {
            setLoaded({
              photoId,
              status: { state: 'unavailable', providerId: null, providerLabel: null, accountLabel: null },
            });
          }
        });
    };
    load();
    const unsubscribe = window.overlook.backup.onEphemeralState((event) => {
      if (event.photoId === photoId && (event.stage === 'error' || event.stage === 'ready' || event.stage === 'released')) load();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [enabled, photoId]);
  return enabled && loaded?.photoId === photoId ? loaded.status : null;
}
