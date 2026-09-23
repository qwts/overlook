import { useEffect, useState } from 'react';
import { thumbUrl } from '../../../shared/library/thumb-url.js';

/** Regenerated derivatives need a new URL even when the selected record stays put. */
export function usePhotoThumbnailUrl(photoId: string | null): string | undefined {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (photoId === null) return;
    return window.overlook.library.onChanged(({ photoIds }) => {
      if (photoIds.length === 0 || photoIds.includes(photoId)) setEpoch((value) => value + 1);
    });
  }, [photoId]);
  return photoId === null ? undefined : `${thumbUrl(photoId)}&v=${String(epoch)}`;
}
