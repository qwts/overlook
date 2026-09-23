import type { PhotoRecord } from '../library/types.js';
import { photoCommandAvailability } from './photo-availability.js';

export type RepairablePhoto = Pick<
  PhotoRecord,
  'id' | 'deletedAt' | 'locked' | 'syncState' | 'fileKind' | 'previewFailure' | 'dimensionStatus'
>;

export function needsPhotoRepair(photo: RepairablePhoto): boolean {
  return photo.previewFailure !== null || photo.dimensionStatus === 'unavailable';
}

/** Shared presentation and main-side admission for the image repair queue. */
export function photoRepairBlocker(
  photo: RepairablePhoto | undefined,
): 'missing' | 'deleted' | 'locked' | 'offloaded' | 'unsupported' | 'healthy' | null {
  if (photo === undefined) return 'missing';
  if (photo.deletedAt !== null) return 'deleted';
  if (!photoCommandAvailability('photo.repair', photo.locked).enabled) return 'locked';
  if (photo.syncState === 'offloaded') return 'offloaded';
  if (!['jpeg', 'png', 'raw', 'heic', 'gif', 'webp'].includes(photo.fileKind)) return 'unsupported';
  return needsPhotoRepair(photo) ? null : 'healthy';
}
