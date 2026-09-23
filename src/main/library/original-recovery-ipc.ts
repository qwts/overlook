import electron from 'electron';
import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler, type IpcHandlerRegistrar } from '../../shared/ipc/registry.js';
import type { OriginalRecoveryService } from './original-recovery-service.js';

export function registerOriginalRecoveryHandlers(
  getService: () => Pick<OriginalRecoveryService, 'recover'>,
  admit: () => void,
  epoch: () => number,
  pickSource: () => Promise<string | null>,
  registrar: IpcHandlerRegistrar = electron.ipcMain,
): void {
  registrar.handle(channels.photoRecoverOriginal.name, (_event, request: unknown) =>
    wrapHandler(channels.photoRecoverOriginal, async ({ photoId }) => {
      admit();
      const service = getService();
      const before = epoch();
      const source = await pickSource();
      if (source === null || before !== epoch()) return { status: 'cancelled' as const };
      admit();
      return { status: await service.recover(photoId, source) };
    })(request),
  );
}
