import electron from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler } from '../../shared/ipc/registry.js';
import type { FileProviderService } from './file-provider-service.js';

type IpcHandler = (event: unknown, request: unknown) => unknown;

export interface FileProviderIpcRegistrar {
  readonly handle: (channel: string, handler: IpcHandler) => void;
}

function snapshot(service: FileProviderService) {
  return { ...service.status(), albums: service.availableAlbums() };
}

export function registerFileProviderHandlersWith(
  getService: () => FileProviderService,
  admit: () => void,
  registrar: FileProviderIpcRegistrar,
): void {
  registrar.handle(channels.fileProviderStatus.name, (_event, request: unknown) =>
    wrapHandler(channels.fileProviderStatus, () => snapshot(getService()))(request),
  );
  registrar.handle(channels.fileProviderEnable.name, (_event, request: unknown) =>
    wrapHandler(channels.fileProviderEnable, async ({ scope, consentVersion }) => {
      admit();
      await getService().enable(scope, consentVersion);
      return snapshot(getService());
    })(request),
  );
  registrar.handle(channels.fileProviderDisable.name, (_event, request: unknown) =>
    wrapHandler(channels.fileProviderDisable, async () => {
      admit();
      await getService().disable();
      return snapshot(getService());
    })(request),
  );
}

export function registerFileProviderHandlers(getService: () => FileProviderService, admit: () => void): void {
  registerFileProviderHandlersWith(getService, admit, electron.ipcMain);
}
