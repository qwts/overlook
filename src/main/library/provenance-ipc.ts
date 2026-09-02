import electron from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler, type IpcHandlerRegistrar } from '../../shared/ipc/registry.js';
import type { ProvenanceService } from './provenance-service.js';

// Provenance over IPC (#495, ADR-0031 §5). Reads evaluate lazily and locally;
// a written record owes the backup a manifest generation (§7).
export function registerProvenanceHandlersWith(
  getService: () => ProvenanceService,
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
  registrar.handle(channels.photoProvenance.name, (_event, request: unknown) =>
    handle(channels.photoProvenance, async ({ photoId }) => {
      const before = getService().current(photoId).evidence?.evaluatedAt ?? null;
      const payload = await getService().get(photoId);
      if (payload.evidence !== null && payload.evidence.evaluatedAt !== before) onManifestChanged?.();
      return payload;
    })(request),
  );
  registrar.handle(channels.photoProvenanceRefresh.name, (_event, request: unknown) =>
    handle(channels.photoProvenanceRefresh, async ({ photoId }) => {
      const payload = await getService().refresh(photoId);
      if (payload.status === 'evaluated') onManifestChanged?.();
      return payload;
    })(request),
  );
}

export function registerProvenanceHandlers(getService: () => ProvenanceService, admit: () => void, onManifestChanged?: () => void): void {
  registerProvenanceHandlersWith(getService, admit, electron.ipcMain, onManifestChanged);
}
