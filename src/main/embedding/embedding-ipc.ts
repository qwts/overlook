import { ipcMain } from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler } from '../../shared/ipc/registry.js';
import type { EmbeddingService } from './embedding-service.js';

export function registerEmbeddingHandlers(getService: () => EmbeddingService, admit: () => void): void {
  const service = (): EmbeddingService => {
    admit();
    return getService();
  };
  ipcMain.handle(channels.embeddingStatus.name, (_event, request: unknown) =>
    wrapHandler(channels.embeddingStatus, () => service().status())(request),
  );
  ipcMain.handle(channels.embeddingEnable.name, (_event, request: unknown) =>
    wrapHandler(channels.embeddingEnable, () => service().enable())(request),
  );
  ipcMain.handle(channels.embeddingDisable.name, (_event, request: unknown) =>
    wrapHandler(channels.embeddingDisable, () => service().disable())(request),
  );
  ipcMain.handle(channels.embeddingPause.name, (_event, request: unknown) =>
    wrapHandler(channels.embeddingPause, () => service().pause())(request),
  );
  ipcMain.handle(channels.embeddingResume.name, (_event, request: unknown) =>
    wrapHandler(channels.embeddingResume, () => service().resume())(request),
  );
}
