import electron from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler, type IpcHandlerRegistrar } from '../../shared/ipc/registry.js';
import type { HistogramService } from './histogram-service.js';

// Inspector histogram over IPC (#498): one read-only lookup per photo.
export function registerHistogramHandlersWith(getService: () => HistogramService, admit: () => void, registrar: IpcHandlerRegistrar): void {
  registrar.handle(channels.photoHistogram.name, (_event, request: unknown) =>
    wrapHandler(
      channels.photoHistogram,
      ({ photoId }) => {
        admit();
        return getService().get(photoId);
      },
      {
        reportError: ({ channelName, code, error }) => console.error(`[overlook] ${code} on ${channelName}`, error),
      },
    )(request),
  );
}

export function registerHistogramHandlers(getService: () => HistogramService, admit: () => void): void {
  registerHistogramHandlersWith(getService, admit, electron.ipcMain);
}
