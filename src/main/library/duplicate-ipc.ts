import electron from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler, type IpcHandlerRegistrar } from '../../shared/ipc/registry.js';
import type { DuplicateIndexService } from './duplicate-index-service.js';

// Perceptual duplicate review over IPC (#650): the derived review and the
// explicit rescan. Deletion is not here — the dialog routes it through the
// ordinary library delete so #482's protection applies unchanged.
export function registerDuplicateHandlersWith(
  getService: () => DuplicateIndexService,
  admit: () => void,
  registrar: IpcHandlerRegistrar,
): void {
  const reportError = ({ channelName, code, error }: { channelName: string; code: string; error: unknown }): void =>
    console.error(`[overlook] ${code} on ${channelName}`, error);
  registrar.handle(channels.duplicatesReview.name, (_event, request: unknown) =>
    wrapHandler(
      channels.duplicatesReview,
      () => {
        admit();
        return getService().reviewWithPhotos();
      },
      { reportError },
    )(request),
  );
  registrar.handle(channels.duplicatesRescan.name, (_event, request: unknown) =>
    wrapHandler(
      channels.duplicatesRescan,
      () => {
        admit();
        return getService().rescan();
      },
      { reportError },
    )(request),
  );
}

export function registerDuplicateHandlers(getService: () => DuplicateIndexService, admit: () => void): void {
  registerDuplicateHandlersWith(getService, admit, electron.ipcMain);
}
