import { useCallback, useEffect, useRef, type Dispatch } from 'react';

import type { CommandId, CommandSurface } from '../../../shared/commands/registry.js';
import type { AppAction, AppState } from '../../../shared/library/app-state.js';
import type { SettingsSection } from '../settings/SettingsDialog';
import { deletePhoto } from './delete-photo';

/**
 * Routes a native-menu / shortcut command (delivered over IPC as an
 * incrementing sequence) to its renderer handler (#531 / #689). Extracted from
 * `Shell` so the command surface is a single self-contained unit and Shell stays
 * within the file-size budget. Every handler dispatches the SAME registry command
 * whose handler backs the toolbar / context menu (ADR-0024 parity).
 *
 * Returns the executor as a `runCommand(id)` function so the Windows/Linux
 * titlebar Help menu (#699) — which has no native menu to deliver over IPC —
 * can invoke Help commands through the identical path (parity, ADR-0024 §5 / I1).
 */
export interface NativeCommandRouterDeps {
  readonly nativeCommand: { readonly id: CommandId; readonly sequence: number } | null;
  readonly state: AppState;
  readonly dispatch: Dispatch<AppAction>;
  readonly setShortcutSurface: (surface: CommandSurface | null) => void;
  readonly setSettingsSection: (section: SettingsSection | undefined) => void;
  readonly setExportPhotoIds: (ids: readonly string[] | null) => void;
  readonly setExportAllPhotos: (allPhotos: boolean) => void;
  readonly setAlbumPickerIds: (ids: readonly string[] | null) => void;
  readonly setLibrariesCreating: (creating: boolean) => void;
  readonly resetInteropEntry: () => void;
  readonly resetUnlockAlbum: () => void;
  readonly resetDropped: () => void;
  readonly closeOffload: () => void;
  readonly pcloudEnabled: boolean;
}

export function useNativeCommandRouter(deps: NativeCommandRouterDeps): (command: CommandId) => void {
  const {
    nativeCommand,
    state,
    dispatch,
    setShortcutSurface,
    setSettingsSection,
    setExportPhotoIds,
    setExportAllPhotos,
    setAlbumPickerIds,
    setLibrariesCreating,
    resetInteropEntry,
    resetUnlockAlbum,
    resetDropped,
    closeOffload,
    pcloudEnabled,
  } = deps;
  const handledSequenceRef = useRef(0);

  const runCommand = useCallback(
    (commandId: CommandId): void => {
      // A deterministic photo target: the focused lightbox photo, else the selection.
      const targetIds = state.lightboxId !== null ? [state.lightboxId] : [...state.selection];
      const closeOverlays = (): void => {
        setShortcutSurface(null);
        resetInteropEntry();
        resetUnlockAlbum();
        closeOffload();
        resetDropped();
        setExportPhotoIds(null);
        setExportAllPhotos(false);
        dispatch({ type: 'lightbox/closed' });
        dispatch({ type: 'dialog/set', dialog: 'import', open: false });
        dispatch({ type: 'dialog/set', dialog: 'export', open: false });
        dispatch({ type: 'dialog/set', dialog: 'settings', open: false });
        dispatch({ type: 'dialog/set', dialog: 'libraries', open: false });
      };
      const openSettings = (section: SettingsSection): void => {
        closeOverlays();
        setSettingsSection(section);
        dispatch({ type: 'dialog/set', dialog: 'settings', open: true });
      };
      if (commandId.startsWith('album.reorder.')) return;
      switch (commandId) {
        case 'app.settings.open':
          openSettings('general');
          return;
        case 'app.settings.open.storage':
          openSettings('storage');
          return;
        case 'app.settings.open.transfer':
          if (!pcloudEnabled) return;
          openSettings('transfer');
          return;
        case 'app.settings.open.privacy':
          openSettings('privacy');
          return;
        case 'library.switch':
          closeOverlays();
          dispatch({ type: 'dialog/set', dialog: 'libraries', open: true });
          return;
        case 'library.new':
          closeOverlays();
          setLibrariesCreating(true);
          dispatch({ type: 'dialog/set', dialog: 'libraries', open: true });
          return;
        case 'library.move':
          closeOverlays();
          dispatch({ type: 'dialog/set', dialog: 'libraries', open: true });
          return;
        case 'library.import':
          closeOverlays();
          dispatch({ type: 'dialog/set', dialog: 'import', open: true });
          return;
        case 'library.exportAll':
          if (state.protectedAlbum !== null) return;
          closeOverlays();
          setExportAllPhotos(true);
          dispatch({ type: 'dialog/set', dialog: 'export', open: true });
          return;
        case 'library.source.all':
        case 'library.source.favorites':
        case 'library.source.recent':
        case 'library.source.trash':
          closeOverlays();
          dispatch({
            type: 'source/set',
            source:
              commandId === 'library.source.all'
                ? 'all'
                : commandId === 'library.source.favorites'
                  ? 'favorites'
                  : commandId === 'library.source.recent'
                    ? 'recent'
                    : 'deleted',
          });
          return;
        case 'selection.selectAll':
          dispatch({ type: 'selection/all', photoIds: state.photos.map(({ id }) => id) });
          return;
        case 'selection.clear':
          dispatch({ type: 'selection/cleared' });
          return;
        case 'history.undo':
        case 'history.redo': {
          const operation = commandId === 'history.undo' ? window.overlook.history.undo : window.overlook.history.redo;
          void operation({ requestId: crypto.randomUUID() }).then((result) => {
            dispatch({
              type: 'toast/shown',
              toast: {
                title: result.applied
                  ? commandId === 'history.undo'
                    ? 'Undid last action'
                    : 'Redid last action'
                  : `Cannot ${commandId === 'history.undo' ? 'undo' : 'redo'} — ${result.capability.reason}`,
                tone: result.applied ? 'neutral' : 'red',
              },
            });
          });
          return;
        }
        case 'view.inspector.toggle':
          dispatch({ type: 'inspector/toggled' });
          return;
        case 'view.inspector.detach':
          dispatch({ type: 'inspector/detached' });
          return;
        case 'view.sidebar.toggle':
          dispatch({ type: 'sidebar/toggled' });
          return;
        case 'view.mode.grid':
        case 'view.mode.list':
        case 'view.mode.moodboard':
          dispatch({
            type: 'view/set',
            view: commandId === 'view.mode.grid' ? 'grid' : commandId === 'view.mode.list' ? 'list' : 'moodboard',
          });
          return;
        case 'view.lightbox.close':
          dispatch({ type: 'lightbox/closed' });
          return;
        case 'photo.favorite.toggle':
          for (const id of targetIds) {
            void window.overlook.library.toggleFavorite({ id }).then(({ pendingCount }) => {
              dispatch({ type: 'pendingCount/set', count: pendingCount });
            });
          }
          return;
        case 'photo.trash': {
          if (state.lightboxId !== null) {
            const target = state.photos.find(({ id }) => id === state.lightboxId);
            if (target?.deletedAt === null) deletePhoto(target.id, dispatch);
            return;
          }
          if (targetIds.length === 0) return;
          void window.overlook.library.delete({ photoIds: targetIds }).then(({ deleted, protected: protectedCount }) => {
            dispatch({
              type: 'toast/shown',
              toast: {
                title:
                  protectedCount === 0
                    ? `Moved ${deleted} ${deleted === 1 ? 'photo' : 'photos'} to Trash`
                    : `Moved ${deleted} to Trash · preserved ${protectedCount} protected ${protectedCount === 1 ? 'Original' : 'Originals'}`,
                tone: protectedCount === 0 ? 'neutral' : 'amber',
              },
            });
          });
          return;
        }
        case 'photo.export':
          setExportAllPhotos(false);
          setExportPhotoIds(targetIds);
          dispatch({ type: 'dialog/set', dialog: 'export', open: true });
          return;
        case 'photo.restore':
          if (targetIds.length === 0) return;
          void window.overlook.library.restore({ photoIds: targetIds }).then(({ restored }) => {
            dispatch({
              type: 'toast/shown',
              toast: { title: `Restored ${restored} ${restored === 1 ? 'photo' : 'photos'}`, tone: 'green' },
            });
          });
          return;
        case 'album.membership.add':
          if (targetIds.length > 0) setAlbumPickerIds(targetIds);
          return;
        case 'album.membership.remove': {
          const albumId = state.album;
          if (albumId === null || targetIds.length === 0) return;
          void window.overlook.albums.removePhotos({ albumId, photoIds: targetIds }).then(({ removed }) => {
            dispatch({
              type: 'toast/shown',
              toast: { title: `Removed ${removed} ${removed === 1 ? 'photo' : 'photos'} from the album`, tone: 'neutral' },
            });
          });
          return;
        }
        case 'help.shortcuts':
          setShortcutSurface(state.lightboxId === null ? 'grid' : 'lightbox');
          return;
        case 'help.activity':
          // Menu-only Activity surface (#690). Clear every open overlay first so
          // Activity never stacks a second focus-trapping Dialog on top of one
          // already mounted.
          closeOverlays();
          dispatch({ type: 'dialog/set', dialog: 'activity', open: true });
          return;
        case 'help.open':
          // macOS opens this from main (the menu never forwards it to the
          // renderer); the Windows/Linux titlebar Help menu reaches it here.
          void window.overlook.help.open();
          return;
        case 'album.rename':
        case 'album.delete':
        case 'album.transfer':
        case 'photo.open':
        case 'photo.offload':
        case 'photo.restoreOriginal':
        case 'photo.transfer':
        case 'photo.original.mark':
        case 'photo.original.unmark':
        case 'photo.purge':
        case 'trash.empty':
        case 'app.lock.now':
        case 'app.search.focus':
        case 'view.lightbox.previous':
        case 'view.lightbox.next':
        case 'view.lightbox.zoomIn':
        case 'view.lightbox.zoomOut':
        case 'view.lightbox.zoomReset':
        case 'view.lightbox.rotateLeft':
        case 'view.lightbox.rotateRight':
        case 'view.lightbox.flipHorizontal':
        case 'view.lightbox.flipVertical':
        case 'view.lightbox.orientationReset':
        case 'grid.focus.left':
        case 'grid.focus.right':
        case 'grid.focus.up':
        case 'grid.focus.down':
        case 'grid.focus.home':
        case 'grid.focus.end':
        case 'grid.focus.pageUp':
        case 'grid.focus.pageDown':
          return;
      }
    },
    [
      dispatch,
      state,
      setShortcutSurface,
      setSettingsSection,
      setExportPhotoIds,
      setExportAllPhotos,
      setAlbumPickerIds,
      setLibrariesCreating,
      resetInteropEntry,
      resetUnlockAlbum,
      resetDropped,
      closeOffload,
      pcloudEnabled,
    ],
  );

  useEffect(() => {
    if (nativeCommand === null || handledSequenceRef.current === nativeCommand.sequence) return;
    handledSequenceRef.current = nativeCommand.sequence;
    runCommand(nativeCommand.id);
  }, [nativeCommand, runCommand]);

  return runCommand;
}
