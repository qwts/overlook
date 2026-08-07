import { ipcMain } from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler } from '../../shared/ipc/registry.js';
import type { LibraryService } from './library-service.js';

export function registerPhotoMetadataHandlers(getService: () => LibraryService, admit: () => void): void {
  const handle: typeof wrapHandler = (channel, handler) =>
    wrapHandler(
      channel,
      (request) => {
        admit();
        return handler(request);
      },
      {
        reportError: ({ channelName, code, error }) => console.error(`[overlook] ${code} on ${channelName}`, error),
      },
    );
  ipcMain.handle(channels.libraryMetadataUpdate.name, (_event, request: unknown) =>
    handle(channels.libraryMetadataUpdate, (metadata) => getService().updateMetadata(metadata))(request),
  );
  ipcMain.handle(channels.libraryMetadataSummary.name, (_event, request: unknown) =>
    handle(channels.libraryMetadataSummary, ({ photoIds }) => getService().metadataSummary(photoIds))(request),
  );
  ipcMain.handle(channels.libraryTagManage.name, (_event, request: unknown) =>
    handle(channels.libraryTagManage, (tag) => getService().manageTag(tag))(request),
  );
  ipcMain.handle(channels.libraryTagSuggestions.name, (_event, request: unknown) =>
    handle(channels.libraryTagSuggestions, ({ query, limit }) => ({ tags: getService().tagSuggestions(query, limit) }))(request),
  );
}
