import { ipcMain } from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler } from '../../shared/ipc/registry.js';
import type { HistogramService } from './histogram-service.js';

// Inspector histogram over IPC (#498): one read-only lookup per photo.
export function registerHistogramHandlers(getService: () => HistogramService, admit: () => void): void {
  ipcMain.handle(channels.photoHistogram.name, (_event, request: unknown) =>
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
