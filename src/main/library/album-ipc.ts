import { ipcMain } from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import type { wrapHandler as createValidatedHandler } from '../../shared/ipc/registry.js';
import { mutateWithActivity } from '../activity/activity-publication.js';
import type { ActivityFacade } from '../activity/activity-publication.js';
import { albumMembershipCommand, albumOrderCommand } from '../history/command-drafts.js';
import type { LibraryService } from './library-service.js';

export function registerAlbumIpcHandlers(
  getService: () => LibraryService,
  newId: () => string,
  wrapHandler: typeof createValidatedHandler,
  getActivity?: () => ActivityFacade,
  onManifestChanged?: () => void,
): void {
  ipcMain.handle(channels.albumCreate.name, (_event, request: unknown) =>
    wrapHandler(channels.albumCreate, ({ name }) =>
      mutateWithActivity(
        getActivity,
        () => ({ album: getService().createAlbum(newId(), name) }),
        ({ album }) => ({ eventType: 'album.created', entityIds: [album.id], outcome: 'succeeded', payload: {} }),
      ),
    )(request),
  );
  ipcMain.handle(channels.albumSetVisibility.name, (_event, request: unknown) =>
    wrapHandler(channels.albumSetVisibility, ({ albumId, showInAllPhotos }) =>
      mutateWithActivity(
        getActivity,
        () => ({ album: getService().setAlbumVisibility(albumId, showInAllPhotos) }),
        () => ({ eventType: 'album.visibility-changed', entityIds: [albumId], outcome: 'succeeded', payload: { showInAllPhotos } }),
      ),
    )(request),
  );
  ipcMain.handle(channels.albumRename.name, (_event, request: unknown) =>
    wrapHandler(channels.albumRename, ({ albumId, name }) => {
      mutateWithActivity(
        getActivity,
        () => getService().renameAlbum(albumId, name),
        () => ({ eventType: 'album.renamed', entityIds: [albumId], outcome: 'succeeded', payload: {} }),
      );
      return {};
    })(request),
  );
  ipcMain.handle(channels.albumDelete.name, (_event, request: unknown) =>
    wrapHandler(channels.albumDelete, ({ albumId }) => {
      mutateWithActivity(
        getActivity,
        () => getService().deleteAlbum(albumId),
        () => ({ eventType: 'album.deleted', entityIds: [albumId], outcome: 'succeeded', payload: {} }),
      );
      return {};
    })(request),
  );
  ipcMain.handle(channels.albumAddPhotos.name, (_event, request: unknown) =>
    wrapHandler(channels.albumAddPhotos, ({ albumId, photoIds }) =>
      mutateWithActivity(
        getActivity,
        () => getService().addToAlbum(albumId, photoIds),
        (result) =>
          result.added === 0
            ? undefined
            : {
                eventType: 'album.membership-added',
                entityIds: [albumId, ...photoIds],
                outcome: 'succeeded',
                payload: { count: result.added },
              },
        (result) => albumMembershipCommand(albumId, result.changedPhotoIds, 'add'),
      ),
    )(request),
  );
  ipcMain.handle(channels.albumRemovePhotos.name, (_event, request: unknown) =>
    wrapHandler(channels.albumRemovePhotos, ({ albumId, photoIds }) =>
      mutateWithActivity(
        getActivity,
        () => getService().removeFromAlbum(albumId, photoIds),
        (result) =>
          result.removed === 0
            ? undefined
            : {
                eventType: 'album.membership-removed',
                entityIds: [albumId, ...photoIds],
                outcome: 'succeeded',
                payload: { count: result.removed },
              },
        (result) => albumMembershipCommand(albumId, result.changedPhotoIds, 'remove'),
      ),
    )(request),
  );
  ipcMain.handle(channels.albumMovePhotos.name, (_event, request: unknown) =>
    wrapHandler(channels.albumMovePhotos, ({ sourceAlbumId, targetAlbumId, photoIds }) =>
      mutateWithActivity(
        getActivity,
        () => getService().moveBetweenAlbums(sourceAlbumId, targetAlbumId, photoIds),
        (result) =>
          result.moved === 0 && result.alreadyInTarget === 0
            ? undefined
            : {
                eventType: 'album.membership-moved',
                entityIds: [sourceAlbumId, targetAlbumId, ...photoIds],
                outcome: result.alreadyInTarget > 0 ? 'partial' : 'succeeded',
                payload: { count: result.moved, alreadyInTarget: result.alreadyInTarget },
              },
      ),
    )(request),
  );
  ipcMain.handle(channels.albumReorder.name, (_event, request: unknown) =>
    wrapHandler(channels.albumReorder, ({ albumId, position, commandId }) => {
      const result = mutateWithActivity(
        getActivity,
        () => getService().reorderAlbum(albumId, position),
        (completed) =>
          completed.changed
            ? {
                eventType: 'album.reordered',
                entityIds: [albumId],
                outcome: 'succeeded',
                payload: { position: completed.after.indexOf(albumId) + 1, total: completed.after.length },
              }
            : undefined,
        (completed) => albumOrderCommand(commandId, albumId, completed.before, completed.after),
      );
      if (result.changed) onManifestChanged?.();
      return { changed: result.changed, position: result.after.indexOf(albumId), total: result.after.length };
    })(request),
  );
}
