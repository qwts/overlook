import electron from 'electron';

import { mutateWithActivity, type ActivityFacade } from '../activity/activity-publication.js';
import { channels } from '../../shared/ipc/channels.js';
import type { EditMutationResult } from '../../shared/ipc/photo-edit-channels.js';
import { wrapHandler, type IpcHandlerRegistrar } from '../../shared/ipc/registry.js';
import type { EditMutationKind, PhotoEditService } from './photo-edit-service.js';

// Persisted edits over IPC (#493, ADR-0031 §2). Every mutation that advances
// a head records a `photo.edited` activity event and owes the backup a
// manifest generation (§7); a no-op save records nothing.
export function registerPhotoEditHandlersWith(
  getService: () => PhotoEditService,
  admit: () => void,
  registrar: IpcHandlerRegistrar,
  getActivity?: () => ActivityFacade,
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
  const publish = (kind: EditMutationKind, photoId: string, result: EditMutationResult): EditMutationResult => {
    if (!result.changed) return result;
    mutateWithActivity(
      getActivity,
      () => result,
      () => ({
        eventType: 'photo.edited',
        entityIds: [photoId],
        outcome: result.derivatives === 'failed' ? 'partial' : 'succeeded',
        payload: {
          kind,
          revisionId: result.head?.id ?? null,
          operations: result.head?.operations.length ?? 0,
          derivatives: result.derivatives,
        },
      }),
    );
    onManifestChanged?.();
    return result;
  };
  registrar.handle(channels.photoEditHead.name, (_event, request: unknown) =>
    handle(channels.photoEditHead, ({ photoId }) => getService().head(photoId))(request),
  );
  registrar.handle(channels.photoEditSave.name, (_event, request: unknown) =>
    handle(channels.photoEditSave, async ({ photoId, operations }) =>
      publish('save', photoId, await getService().save(photoId, operations)),
    )(request),
  );
  registrar.handle(channels.photoEditReset.name, (_event, request: unknown) =>
    handle(channels.photoEditReset, async ({ photoId }) => publish('reset', photoId, await getService().reset(photoId)))(request),
  );
  registrar.handle(channels.photoEditRevert.name, (_event, request: unknown) =>
    handle(channels.photoEditRevert, async ({ photoId, revisionId }) =>
      publish('revert', photoId, await getService().revert(photoId, revisionId)),
    )(request),
  );
}

export function registerPhotoEditHandlers(
  getService: () => PhotoEditService,
  admit: () => void,
  getActivity?: () => ActivityFacade,
  onManifestChanged?: () => void,
): void {
  registerPhotoEditHandlersWith(getService, admit, electron.ipcMain, getActivity, onManifestChanged);
}
