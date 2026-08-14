import type { RestoreCandidate } from './restore-discovery.js';
import type { RestoreProgress } from './restore-types.js';

export interface ScanTicker {
  tick(photoId: string | null): void;
}

export function verifyObjectCount(candidate: RestoreCandidate): number {
  const sidecars = candidate.manifest.schema === 6 ? candidate.manifest.sidecars.length : 0;
  const protectedObjects =
    candidate.manifest.schema === 2
      ? 0
      : candidate.manifest.protectedPhotos.reduce(
          (sum, photo) => sum + photo.objects.filter((object) => object.status === 'synced').length,
          0,
        );
  return candidate.manifest.photos.length + sidecars + protectedObjects;
}

export function createScanTicker(
  total: number,
  emit: (stage: RestoreProgress['stage'], done: number, total: number, photoId: string | null) => void,
): ScanTicker {
  let done = 0;
  emit('verifying', 0, total, null);
  return {
    tick: (photoId) => {
      done += 1;
      emit('verifying', done, total, photoId);
    },
  };
}
