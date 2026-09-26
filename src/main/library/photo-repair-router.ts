import { photoRepairBlocker, type RepairablePhoto } from '../../shared/commands/photo-repair.js';

/** Route the requested row to its existing decoder without running a broad pass. */
export function createPhotoRepairRouter(options: {
  readonly getPhoto: (photoId: string) => RepairablePhoto | undefined;
  readonly repairImage: (photoId: string) => Promise<void>;
  readonly captureVideo: (photoId: string) => Promise<void>;
}): { readonly repairPhoto: (photoId: string) => Promise<void> } {
  return {
    repairPhoto: async (photoId) => {
      const photo = options.getPhoto(photoId);
      if (photo === undefined || photoRepairBlocker(photo) !== null) return;
      if (photo.fileKind === 'video') await options.captureVideo(photoId);
      else await options.repairImage(photoId);
    },
  };
}
