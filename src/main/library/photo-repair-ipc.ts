import electron from 'electron';
import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler, type IpcHandlerRegistrar } from '../../shared/ipc/registry.js';
import { photoRepairBlocker, type RepairablePhoto } from '../../shared/commands/photo-repair.js';
import type { PhotoRepairResult } from '../../shared/ipc/photo-repair-channels.js';

export interface PhotoRepairRuntime {
  readonly getPhoto: (photoId: string) => RepairablePhoto | undefined;
  readonly repairPhoto: (photoId: string) => Promise<void>;
  /** Captured library and authorization epoch must still own the operation. */
  readonly isCurrent: () => boolean;
}

export async function retryPhotoRepair(runtime: PhotoRepairRuntime, photoId: string): Promise<PhotoRepairResult> {
  if (!runtime.isCurrent()) return { status: 'unavailable' };
  const blocker = photoRepairBlocker(runtime.getPhoto(photoId));
  if (blocker !== null) return { status: blocker === 'healthy' ? 'unchanged' : 'unavailable' };
  await runtime.repairPhoto(photoId);
  // Do not touch a closed old library or inspect a different library after await.
  if (!runtime.isCurrent()) return { status: 'unavailable' };
  const after = photoRepairBlocker(runtime.getPhoto(photoId));
  return { status: after === 'healthy' ? 'repaired' : after === null ? 'failed' : 'unavailable' };
}

export function registerPhotoRepairHandlers(
  getRuntime: () => PhotoRepairRuntime,
  admit: () => void,
  registrar: IpcHandlerRegistrar = electron.ipcMain,
): void {
  registrar.handle(channels.photoRepair.name, (_event, request: unknown) =>
    wrapHandler(channels.photoRepair, async ({ photoId }) => {
      admit();
      const result = await retryPhotoRepair(getRuntime(), photoId);
      admit();
      return result;
    })(request),
  );
}
