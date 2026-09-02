import { ipcMain } from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler } from '../../shared/ipc/registry.js';
import type { CoverageService } from './coverage-service.js';

// Backup coverage over IPC (#506): preflight is read-only; exclude and
// include mutate custody and count as provider work while they run.
export function registerCoverageHandlers(
  getService: () => CoverageService,
  admit: () => void,
  withProviderWork: <T>(operation: () => Promise<T>) => Promise<T>,
): void {
  const reportError = ({ channelName, code, error }: { channelName: string; code: string; error: unknown }): void =>
    console.error(`[overlook] ${code} on ${channelName}`, error);
  ipcMain.handle(channels.coveragePreflight.name, (_event, request: unknown) =>
    wrapHandler(
      channels.coveragePreflight,
      async ({ photoIds }) => {
        admit();
        return getService().preflight(photoIds);
      },
      { reportError },
    )(request),
  );
  ipcMain.handle(channels.coverageExclude.name, (_event, request: unknown) =>
    wrapHandler(
      channels.coverageExclude,
      async ({ photoIds, authorization }) => {
        admit();
        return withProviderWork(() => getService().exclude(photoIds, authorization));
      },
      { reportError },
    )(request),
  );
  ipcMain.handle(channels.coverageInclude.name, (_event, request: unknown) =>
    wrapHandler(
      channels.coverageInclude,
      async ({ photoIds }) => {
        admit();
        return withProviderWork(() => getService().include(photoIds));
      },
      { reportError },
    )(request),
  );
}
