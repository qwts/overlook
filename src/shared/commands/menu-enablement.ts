import { commandById, type CommandId } from './registry.js';
import type { CommandMenuContext } from './menu-contract.js';

function locked(context: CommandMenuContext): boolean {
  return context.surface === 'locked';
}

/** A deterministic photo target: the focused lightbox photo or an intentional selection. */
function hasPhotoTarget(context: CommandMenuContext): boolean {
  return (context.surface === 'lightbox' && context.hasTarget) || context.selectionCount > 0;
}

/** Whether a command can run in the given menu context. The macOS native
 *  menu and the Windows/Linux titlebar menus both read this, so the two
 *  platforms enable the same commands (ADR-0024 §5, #1293). */
export function commandEnabled(id: CommandId, context: CommandMenuContext): boolean {
  if (locked(context) && commandById(id).native?.lockSafe !== true) return false;
  if (commandById(id).requiresPhotoKey === true && !context.hasPhotoKeyTarget) return false;
  switch (id) {
    case 'app.settings.open':
    case 'app.settings.open.storage':
    case 'app.settings.open.privacy':
    case 'library.switch':
    case 'help.shortcuts':
    case 'help.open':
    case 'view.appearance.reset':
      return true;
    case 'app.settings.open.transfer':
      return context.pcloudEnabled;
    case 'app.lock.now':
      return context.appLockConfigured && !locked(context);
    case 'library.import':
      return context.hasLibrary && !context.providerBusy && !locked(context);
    case 'library.exportAll':
      return context.hasLibrary && context.dialog === 'none' && !context.protectedAlbumOpen;
    case 'library.duplicates':
      // Ordinary-library review (#650): protected albums have no fingerprints.
      return context.hasLibrary && !context.protectedAlbumOpen;
    case 'library.source.all':
    case 'library.source.favorites':
    case 'library.source.recent':
    case 'library.source.trash':
      return context.hasLibrary && !locked(context);
    case 'selection.selectAll':
      return context.surface === 'grid' && context.dialog === 'none' && !context.editable && context.hasPhotos;
    case 'history.undo':
    case 'history.redo':
      return context.hasLibrary && context.dialog === 'none' && !context.editable;
    case 'help.activity':
      // Activity is per-library and unavailable while locked (the lock guard
      // above handles locked); available from any surface with a library.
      return context.hasLibrary;
    case 'view.inspector.toggle':
    case 'view.inspector.detach':
      return (context.surface === 'grid' || context.surface === 'lightbox') && context.dialog === 'none';
    case 'view.mode.grid':
    case 'view.mode.list':
    case 'view.mode.feed':
    case 'view.mode.moodboard':
      return context.surface === 'grid' && context.dialog === 'none';
    case 'view.lightbox.close':
      return context.surface === 'lightbox' && context.dialog === 'none';
    case 'photo.original.mark':
    case 'photo.original.unmark':
      return context.surface === 'lightbox' && context.dialog === 'none' && context.targetTrashable;
    // #689 Photo menu — target-aware (focused lightbox photo or intentional
    // selection), never on Trash rows; the executing adapter revalidates.
    case 'photo.favorite.toggle':
      return context.dialog === 'none' && context.source !== 'deleted' && hasPhotoTarget(context);
    case 'photo.trash':
      // The focused lightbox photo must be trashable; a grid selection is
      // trashable when the route is not already Trash. The adapter revalidates.
      return (
        context.dialog === 'none' &&
        ((context.surface === 'lightbox' && context.hasTarget && context.targetTrashable) ||
          (context.surface !== 'lightbox' && context.source !== 'deleted' && context.selectionCount > 0))
      );
    case 'photo.duplicate':
    case 'photo.export':
      return context.dialog === 'none' && hasPhotoTarget(context);
    case 'album.membership.add':
      return context.dialog === 'none' && context.source !== 'deleted' && context.hasLibrary && hasPhotoTarget(context);
    case 'album.membership.remove':
      return context.dialog === 'none' && context.inAlbum && hasPhotoTarget(context);
    case 'photo.restore':
      return context.dialog === 'none' && context.source === 'deleted' && hasPhotoTarget(context);
    // #689 File/Edit/View additions wired to their handlers.
    case 'library.move':
      return context.hasLibrary && context.dialog === 'none';
    case 'library.new':
      return context.dialog === 'none';
    case 'view.sidebar.toggle':
      return (context.surface === 'grid' || context.surface === 'lightbox') && context.dialog === 'none';
    case 'selection.clear':
      return context.surface === 'grid' && context.dialog === 'none' && !context.editable && context.selectionCount > 0;
    case 'album.rename':
    case 'album.delete':
    case 'album.transfer':
    case 'album.hide':
    case 'album.show':
    case 'album.folder.new':
    case 'album.folder.newInside':
    case 'album.folder.newAlbumInside':
    case 'album.move':
    case 'album.tags':
    case 'album.visibility.inherit':
    case 'album.smart.new':
    case 'album.smart.edit':
    case 'album.duplicate':
    case 'album.reorder.up':
    case 'album.reorder.down':
    case 'album.reorder.top':
    case 'album.reorder.bottom':
    case 'board.layout':
    case 'photo.open':
    case 'photo.repair':
    case 'photo.offload':
    case 'photo.restoreOriginal':
    case 'photo.recoverOriginal':
    case 'photo.coverage.exclude':
    case 'photo.coverage.include':
    case 'photo.transfer':
    case 'photo.purge':
    case 'trash.empty':
      return false;
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
    case 'photo.edit.save':
    case 'photo.edit.reset':
    case 'photo.edit.crop':
    case 'photo.edit.revert':
    case 'grid.focus.left':
    case 'grid.focus.right':
    case 'grid.focus.up':
    case 'grid.focus.down':
    case 'grid.focus.home':
    case 'grid.focus.end':
    case 'grid.focus.pageUp':
    case 'grid.focus.pageDown':
      return false;
  }
}
