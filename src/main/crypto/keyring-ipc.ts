import { ipcMain } from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler } from '../../shared/ipc/registry.js';
import type { KeyringService } from './keyring-service.js';

// The keyring over IPC (#517). Every channel admits through the app-lock
// gate first: a locked library has no keyring to show or change.
export function registerKeyringHandlers(getService: () => KeyringService, admit: () => void): void {
  const reportError = ({ channelName, code, error }: { channelName: string; code: string; error: unknown }): void =>
    console.error(`[overlook] ${code} on ${channelName}`, error);
  const options = { reportError };
  ipcMain.handle(channels.keyringList.name, (_event, request: unknown) =>
    wrapHandler(
      channels.keyringList,
      () => {
        admit();
        return { keys: getService().list() };
      },
      options,
    )(request),
  );
  ipcMain.handle(channels.keyringExport.name, (_event, request: unknown) =>
    wrapHandler(
      channels.keyringExport,
      async ({ id, password }) => {
        admit();
        return { path: await getService().exportKey(id, password) };
      },
      options,
    )(request),
  );
  ipcMain.handle(channels.keyringPickFile.name, (_event, request: unknown) =>
    wrapHandler(
      channels.keyringPickFile,
      async () => {
        admit();
        return { path: await getService().pickFile() };
      },
      options,
    )(request),
  );
  ipcMain.handle(channels.keyringImport.name, (_event, request: unknown) =>
    wrapHandler(
      channels.keyringImport,
      async ({ path, password }) => {
        admit();
        return getService().importKey(path, password);
      },
      options,
    )(request),
  );
  ipcMain.handle(channels.keyringRemovePreflight.name, (_event, request: unknown) =>
    wrapHandler(
      channels.keyringRemovePreflight,
      ({ id }) => {
        admit();
        return getService().removePreflight(id);
      },
      options,
    )(request),
  );
  ipcMain.handle(channels.keyringRemove.name, (_event, request: unknown) =>
    wrapHandler(
      channels.keyringRemove,
      ({ id, authorization }) => {
        admit();
        return getService().remove(id, authorization);
      },
      options,
    )(request),
  );
  ipcMain.handle(channels.keyringSetLabel.name, (_event, request: unknown) =>
    wrapHandler(
      channels.keyringSetLabel,
      ({ id, label }) => {
        admit();
        getService().setLabel(id, label);
        return {};
      },
      options,
    )(request),
  );
}
