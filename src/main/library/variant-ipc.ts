import electron from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler, type IpcHandlerRegistrar } from '../../shared/ipc/registry.js';
import type { VariantService } from './variant-service.js';

// Variants over IPC (#496, ADR-0031 §3). Duplicate and Promote change
// library data, so each owes the backup a manifest generation (§7).
export function registerVariantHandlersWith(
  getService: () => VariantService,
  admit: () => void,
  registrar: IpcHandlerRegistrar,
  onManifestChanged?: () => void,
): void {
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
  registrar.handle(channels.photoDuplicate.name, (_event, request: unknown) =>
    handle(channels.photoDuplicate, async ({ photoIds }) => {
      const result = await getService().duplicate(photoIds);
      if (result.created.length > 0) onManifestChanged?.();
      return result;
    })(request),
  );
  registrar.handle(channels.photoVariants.name, (_event, request: unknown) =>
    handle(channels.photoVariants, ({ photoId }) => Promise.resolve(getService().family(photoId)))(request),
  );
  registrar.handle(channels.photoPromoteVariant.name, (_event, request: unknown) =>
    handle(channels.photoPromoteVariant, ({ photoId }) => {
      const family = getService().promote(photoId);
      onManifestChanged?.();
      return Promise.resolve(family);
    })(request),
  );
}

export function registerVariantHandlers(getService: () => VariantService, admit: () => void, onManifestChanged?: () => void): void {
  registerVariantHandlersWith(getService, admit, electron.ipcMain, onManifestChanged);
}
