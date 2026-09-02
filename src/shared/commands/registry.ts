export type CommandSurface = 'global' | 'grid' | 'lightbox' | 'dialog';
export type CommandPlatform = 'darwin' | 'win32' | 'linux';
export type CommandTarget = 'application' | 'window' | 'route' | 'focused-item' | 'selection';
export type NativeMenu = 'app' | 'file' | 'edit' | 'view' | 'photo' | 'help';

export interface NativeCommandExposure {
  readonly menu: NativeMenu;
  readonly lockSafe: boolean;
  /** Only idempotent navigation commands may wait for a renderer document. */
  readonly queueable: boolean;
}

export interface CommandContext {
  readonly surface: CommandSurface;
  readonly dialogOpen: boolean;
  readonly editable: boolean;
  readonly platform: CommandPlatform;
}

export type QuickActionIcon = 'album' | 'refresh-cw' | 'share' | 'star' | 'trash-2';
export type QuickActionAvailability = 'anywhere' | 'library' | 'trash';

export interface QuickActionExposure {
  readonly icon: QuickActionIcon;
  readonly availability: QuickActionAvailability;
  /** Selection commands act on the selection only when it contains the surfaced photo. */
  readonly target: 'photo' | 'selection-if-included';
}

export interface CommandDescriptor {
  readonly id: CommandId;
  readonly label: { readonly id: string; readonly defaultMessage: string };
  readonly surfaces: readonly CommandSurface[];
  readonly target: CommandTarget;
  readonly key?: string | undefined;
  /** Physical-key binding for position-stable image commands across layouts. */
  readonly code?: string | undefined;
  readonly alternateKeys?: readonly string[] | undefined;
  readonly primaryModifier?: boolean | undefined;
  readonly alt?: boolean | undefined;
  readonly shift?: boolean | undefined;
  readonly native?: NativeCommandExposure | undefined;
  readonly quickAction?: QuickActionExposure | undefined;
}

export type CommandId =
  | 'app.settings.open'
  | 'app.settings.open.storage'
  | 'app.settings.open.transfer'
  | 'app.settings.open.privacy'
  | 'app.lock.now'
  | 'app.search.focus'
  | 'library.switch'
  | 'library.move'
  | 'library.new'
  | 'library.import'
  | 'library.exportAll'
  | 'library.duplicates'
  | 'library.source.all'
  | 'library.source.favorites'
  | 'library.source.recent'
  | 'library.source.trash'
  | 'selection.selectAll'
  | 'selection.clear'
  | 'history.undo'
  | 'history.redo'
  | 'album.membership.add'
  | 'album.membership.remove'
  | 'album.rename'
  | 'album.delete'
  | 'album.transfer'
  | 'album.hide'
  | 'album.show'
  | 'album.reorder.up'
  | 'album.reorder.down'
  | 'album.reorder.top'
  | 'album.reorder.bottom'
  | 'album.folder.new'
  | 'album.move'
  | 'album.tags'
  | 'album.visibility.inherit'
  | 'album.smart.new'
  | 'album.smart.edit'
  | 'album.duplicate'
  | 'view.inspector.toggle'
  | 'view.inspector.detach'
  | 'view.sidebar.toggle'
  | 'view.appearance.reset'
  | 'view.mode.grid'
  | 'view.mode.list'
  | 'view.mode.feed'
  | 'view.mode.moodboard'
  | 'board.layout'
  | 'view.lightbox.close'
  | 'view.lightbox.previous'
  | 'view.lightbox.next'
  | 'photo.favorite.toggle'
  | 'photo.edit.save'
  | 'photo.edit.reset'
  | 'photo.edit.crop'
  | 'photo.edit.revert'
  | 'photo.original.mark'
  | 'photo.original.unmark'
  | 'photo.open'
  | 'photo.export'
  | 'photo.duplicate'
  | 'photo.offload'
  | 'photo.restoreOriginal'
  | 'photo.transfer'
  | 'photo.trash'
  | 'photo.restore'
  | 'photo.purge'
  | 'trash.empty'
  | 'view.lightbox.zoomIn'
  | 'view.lightbox.zoomOut'
  | 'view.lightbox.zoomReset'
  | 'view.lightbox.rotateLeft'
  | 'view.lightbox.rotateRight'
  | 'view.lightbox.flipHorizontal'
  | 'view.lightbox.flipVertical'
  | 'view.lightbox.orientationReset'
  | 'help.shortcuts'
  | 'help.activity'
  | 'help.open'
  | 'grid.focus.left'
  | 'grid.focus.right'
  | 'grid.focus.up'
  | 'grid.focus.down'
  | 'grid.focus.home'
  | 'grid.focus.end'
  | 'grid.focus.pageUp'
  | 'grid.focus.pageDown';

export interface KeyboardLike {
  readonly key: string;
  readonly code?: string | undefined;
  readonly metaKey?: boolean | undefined;
  readonly ctrlKey?: boolean | undefined;
  readonly altKey?: boolean | undefined;
  readonly shiftKey?: boolean | undefined;
}

const GLOBAL_SURFACES: readonly CommandSurface[] = ['global', 'grid', 'lightbox'];
const defineMessages = <T extends Record<string, CommandDescriptor['label']>>(messages: T): T => messages;
const commandLabels: Record<CommandId, CommandDescriptor['label']> = defineMessages({
  'app.settings.open': { id: 'commands.app.settings.open', defaultMessage: 'Settings…' },
  'app.settings.open.storage': { id: 'commands.app.settings.open.storage', defaultMessage: 'Storage & Backup' },
  'app.settings.open.transfer': { id: 'commands.app.settings.open.transfer', defaultMessage: 'Transfer & Sync' },
  'app.settings.open.privacy': { id: 'commands.app.settings.open.privacy', defaultMessage: 'Privacy & Diagnostics' },
  'app.lock.now': { id: 'commands.app.lock.now', defaultMessage: 'Lock Now' },
  'app.search.focus': { id: 'commands.app.search.focus', defaultMessage: 'Focus search' },
  'library.switch': { id: 'commands.library.switch', defaultMessage: 'Switch Library…' },
  'library.move': { id: 'commands.library.move', defaultMessage: 'Move Library…' },
  'library.new': { id: 'commands.library.new', defaultMessage: 'New Library…' },
  'library.import': { id: 'commands.library.import', defaultMessage: 'Import Photos…' },
  'library.exportAll': { id: 'commands.library.exportAll', defaultMessage: 'Export All Unencrypted…' },
  'library.duplicates': { id: 'commands.library.duplicates', defaultMessage: 'Review Duplicates…' },
  'library.source.all': { id: 'commands.library.source.all', defaultMessage: 'All Photos' },
  'library.source.favorites': { id: 'commands.library.source.favorites', defaultMessage: 'Favorites' },
  'library.source.recent': { id: 'commands.library.source.recent', defaultMessage: 'Recent Imports' },
  'library.source.trash': { id: 'commands.library.source.trash', defaultMessage: 'Trash' },
  'selection.selectAll': { id: 'commands.selection.selectAll', defaultMessage: 'Select all photos' },
  'selection.clear': { id: 'commands.selection.clear', defaultMessage: 'Clear selection' },
  'history.undo': { id: 'commands.history.undo', defaultMessage: 'Undo' },
  'history.redo': { id: 'commands.history.redo', defaultMessage: 'Redo' },
  'album.membership.add': { id: 'commands.album.membership.add', defaultMessage: 'Add to album' },
  'album.membership.remove': { id: 'commands.album.membership.remove', defaultMessage: 'Remove from album' },
  'album.rename': { id: 'commands.album.rename', defaultMessage: 'Rename album…' },
  'album.delete': { id: 'commands.album.delete', defaultMessage: 'Delete album…' },
  'album.transfer': { id: 'commands.album.transfer', defaultMessage: 'Transfer & Sync…' },
  'album.hide': { id: 'commands.album.hide', defaultMessage: 'Hide from All Photos' },
  'album.show': { id: 'commands.album.show', defaultMessage: 'Show in All Photos' },
  'album.folder.new': { id: 'commands.album.folder.new', defaultMessage: 'New folder…' },
  'album.move': { id: 'commands.album.move', defaultMessage: 'Move to folder…' },
  'album.tags': { id: 'commands.album.tags', defaultMessage: 'Tags…' },
  'album.visibility.inherit': { id: 'commands.album.visibility.inherit', defaultMessage: 'Use folder setting' },
  'album.smart.new': { id: 'commands.album.smart.new', defaultMessage: 'Save as Smart Album…' },
  'album.smart.edit': { id: 'commands.album.smart.edit', defaultMessage: 'Edit Smart Album' },
  'album.duplicate': { id: 'commands.album.duplicate', defaultMessage: 'Duplicate' },
  'album.reorder.up': { id: 'commands.album.reorder.up', defaultMessage: 'Move up' },
  'album.reorder.down': { id: 'commands.album.reorder.down', defaultMessage: 'Move down' },
  'album.reorder.top': { id: 'commands.album.reorder.top', defaultMessage: 'Move to top' },
  'album.reorder.bottom': { id: 'commands.album.reorder.bottom', defaultMessage: 'Move to bottom' },
  'view.inspector.toggle': { id: 'commands.view.inspector.toggle', defaultMessage: 'Show or hide Inspector' },
  'view.inspector.detach': { id: 'commands.view.inspector.detach', defaultMessage: 'Open Inspector in Separate Window' },
  'view.sidebar.toggle': { id: 'commands.view.sidebar.toggle', defaultMessage: 'Toggle Sidebar' },
  'view.appearance.reset': { id: 'commands.view.appearance.reset', defaultMessage: 'Reset Appearance' },
  'view.mode.grid': { id: 'commands.view.mode.grid', defaultMessage: 'Grid' },
  'view.mode.list': { id: 'commands.view.mode.list', defaultMessage: 'List' },
  'view.mode.feed': { id: 'commands.view.mode.feed', defaultMessage: 'Feed' },
  'view.mode.moodboard': { id: 'commands.view.mode.moodboard', defaultMessage: 'Moodboard' },
  'board.layout': { id: 'commands.board.layout', defaultMessage: 'Edit board' },
  'view.lightbox.close': { id: 'commands.view.lightbox.close', defaultMessage: 'Exit lightbox' },
  'view.lightbox.previous': { id: 'commands.view.lightbox.previous', defaultMessage: 'Previous photo' },
  'view.lightbox.next': { id: 'commands.view.lightbox.next', defaultMessage: 'Next photo' },
  'photo.favorite.toggle': { id: 'commands.photo.favorite.toggle', defaultMessage: 'Toggle favorite' },
  'photo.edit.save': { id: 'commands.photo.edit.save', defaultMessage: 'Save edits' },
  'photo.edit.reset': { id: 'commands.photo.edit.reset', defaultMessage: 'Reset edits' },
  'photo.edit.crop': { id: 'commands.photo.edit.crop', defaultMessage: 'Crop' },
  'photo.edit.revert': { id: 'commands.photo.edit.revert', defaultMessage: 'Revert to previous edit' },
  'photo.original.mark': { id: 'commands.photo.original.mark', defaultMessage: 'Mark as Original' },
  'photo.original.unmark': { id: 'commands.photo.original.unmark', defaultMessage: 'Remove Original protection' },
  'photo.open': { id: 'commands.photo.open', defaultMessage: 'Open' },
  'photo.export': { id: 'commands.photo.export', defaultMessage: 'Export…' },
  'photo.duplicate': { id: 'commands.photo.duplicate', defaultMessage: 'Duplicate' },
  'photo.offload': { id: 'commands.photo.offload', defaultMessage: 'Offload original…' },
  'photo.restoreOriginal': { id: 'commands.photo.restoreOriginal', defaultMessage: 'Restore original' },
  'photo.transfer': { id: 'commands.photo.transfer', defaultMessage: 'Transfer & Sync…' },
  'photo.trash': { id: 'commands.photo.trash', defaultMessage: 'Move photo to Trash' },
  'photo.restore': { id: 'commands.photo.restore', defaultMessage: 'Restore photo' },
  'photo.purge': { id: 'commands.photo.purge', defaultMessage: 'Delete permanently…' },
  'trash.empty': { id: 'commands.trash.empty', defaultMessage: 'Empty Trash…' },
  'view.lightbox.zoomIn': { id: 'commands.view.lightbox.zoomIn', defaultMessage: 'Zoom in' },
  'view.lightbox.zoomOut': { id: 'commands.view.lightbox.zoomOut', defaultMessage: 'Zoom out' },
  'view.lightbox.zoomReset': { id: 'commands.view.lightbox.zoomReset', defaultMessage: 'Reset zoom' },
  'view.lightbox.rotateLeft': { id: 'commands.view.lightbox.rotateLeft', defaultMessage: 'Rotate counterclockwise' },
  'view.lightbox.rotateRight': { id: 'commands.view.lightbox.rotateRight', defaultMessage: 'Rotate clockwise' },
  'view.lightbox.flipHorizontal': { id: 'commands.view.lightbox.flipHorizontal', defaultMessage: 'Flip horizontally' },
  'view.lightbox.flipVertical': { id: 'commands.view.lightbox.flipVertical', defaultMessage: 'Flip vertically' },
  'view.lightbox.orientationReset': { id: 'commands.view.lightbox.orientationReset', defaultMessage: 'Reset orientation' },
  'help.shortcuts': { id: 'commands.help.shortcuts', defaultMessage: 'Keyboard shortcuts' },
  'help.activity': { id: 'commands.help.activity', defaultMessage: 'Activity…' },
  'help.open': { id: 'commands.help.open', defaultMessage: 'Overlook Help' },
  'grid.focus.left': { id: 'commands.grid.focus.left', defaultMessage: 'Move focus left' },
  'grid.focus.right': { id: 'commands.grid.focus.right', defaultMessage: 'Move focus right' },
  'grid.focus.up': { id: 'commands.grid.focus.up', defaultMessage: 'Move focus up' },
  'grid.focus.down': { id: 'commands.grid.focus.down', defaultMessage: 'Move focus down' },
  'grid.focus.home': { id: 'commands.grid.focus.home', defaultMessage: 'Move to row start' },
  'grid.focus.end': { id: 'commands.grid.focus.end', defaultMessage: 'Move to row end' },
  'grid.focus.pageUp': { id: 'commands.grid.focus.pageUp', defaultMessage: 'Move up one page' },
  'grid.focus.pageDown': { id: 'commands.grid.focus.pageDown', defaultMessage: 'Move down one page' },
});

const label = (id: CommandId, _defaultMessage: string): CommandDescriptor['label'] => commandLabels[id];
// Grid focus movement shares one shape: grid surface, focused item, a bare key.
const gridFocus = (id: Extract<CommandId, `grid.focus.${string}`>, text: string, key: string): CommandDescriptor => ({
  id,
  label: label(id, text),
  surfaces: ['grid'],
  target: 'focused-item',
  key,
});

export const COMMANDS: readonly CommandDescriptor[] = [
  {
    id: 'app.settings.open',
    label: label('app.settings.open', 'Settings…'),
    surfaces: ['global'],
    target: 'window',
    key: ',',
    primaryModifier: true,
    native: { menu: 'app', lockSafe: true, queueable: true },
  },
  {
    id: 'app.settings.open.storage',
    label: label('app.settings.open.storage', 'Storage & Backup'),
    surfaces: [],
    target: 'window',
    native: { menu: 'app', lockSafe: true, queueable: true },
  },
  {
    id: 'app.settings.open.transfer',
    label: label('app.settings.open.transfer', 'Transfer & Sync'),
    surfaces: [],
    target: 'window',
    native: { menu: 'app', lockSafe: true, queueable: true },
  },
  {
    id: 'app.settings.open.privacy',
    label: label('app.settings.open.privacy', 'Privacy & Diagnostics'),
    surfaces: [],
    target: 'window',
    native: { menu: 'app', lockSafe: true, queueable: true },
  },
  {
    id: 'app.lock.now',
    label: label('app.lock.now', 'Lock Now'),
    surfaces: [],
    target: 'application',
    native: { menu: 'app', lockSafe: false, queueable: false },
  },
  {
    id: 'app.search.focus',
    label: label('app.search.focus', 'Focus search'),
    surfaces: ['global', 'grid'],
    target: 'window',
    key: 'k',
    primaryModifier: true,
  },
  {
    id: 'library.switch',
    label: label('library.switch', 'Switch Library…'),
    surfaces: [],
    target: 'window',
    native: { menu: 'file', lockSafe: true, queueable: true },
  },
  {
    id: 'library.move',
    label: label('library.move', 'Move Library…'),
    surfaces: [],
    target: 'window',
    key: 'm',
    primaryModifier: true,
    shift: true,
    native: { menu: 'file', lockSafe: false, queueable: true },
  },
  {
    id: 'library.new',
    label: label('library.new', 'New Library…'),
    surfaces: [],
    target: 'window',
    native: { menu: 'file', lockSafe: false, queueable: true },
  },
  {
    id: 'library.import',
    label: label('library.import', 'Import Photos…'),
    surfaces: [],
    target: 'window',
    key: 'i',
    primaryModifier: true,
    native: { menu: 'file', lockSafe: false, queueable: true },
  },
  {
    id: 'library.exportAll',
    label: label('library.exportAll', 'Export All Unencrypted…'),
    surfaces: [],
    target: 'application',
    native: { menu: 'file', lockSafe: false, queueable: false },
  },
  {
    // Perceptual duplicate review (#650): a library-level dialog, so it
    // lives beside Import/Export in File; ⌥⌘D is the item's accelerator and
    // reaches the renderer through the native command route.
    id: 'library.duplicates',
    label: label('library.duplicates', 'Review Duplicates…'),
    surfaces: GLOBAL_SURFACES,
    target: 'window',
    key: 'd',
    code: 'KeyD',
    primaryModifier: true,
    alt: true,
    native: { menu: 'file', lockSafe: false, queueable: true },
  },
  {
    id: 'library.source.all',
    label: label('library.source.all', 'All Photos'),
    surfaces: [],
    target: 'route',
    native: { menu: 'view', lockSafe: false, queueable: true },
  },
  {
    id: 'library.source.favorites',
    label: label('library.source.favorites', 'Favorites'),
    surfaces: [],
    target: 'route',
    native: { menu: 'view', lockSafe: false, queueable: true },
  },
  {
    id: 'library.source.recent',
    label: label('library.source.recent', 'Recent Imports'),
    surfaces: [],
    target: 'route',
    native: { menu: 'view', lockSafe: false, queueable: true },
  },
  {
    id: 'library.source.trash',
    label: label('library.source.trash', 'Trash'),
    surfaces: [],
    target: 'route',
    native: { menu: 'view', lockSafe: false, queueable: true },
  },
  {
    id: 'selection.selectAll',
    label: label('selection.selectAll', 'Select all photos'),
    surfaces: ['grid'],
    target: 'selection',
    key: 'a',
    primaryModifier: true,
    native: { menu: 'edit', lockSafe: false, queueable: false },
  },
  {
    id: 'selection.clear',
    label: label('selection.clear', 'Clear selection'),
    surfaces: ['global', 'grid'],
    target: 'selection',
    key: 'Escape',
    native: { menu: 'edit', lockSafe: false, queueable: false },
  },
  {
    id: 'history.undo',
    label: label('history.undo', 'Undo'),
    surfaces: GLOBAL_SURFACES,
    target: 'application',
    key: 'z',
    primaryModifier: true,
    native: { menu: 'edit', lockSafe: false, queueable: false },
  },
  {
    id: 'history.redo',
    label: label('history.redo', 'Redo'),
    surfaces: GLOBAL_SURFACES,
    target: 'application',
    key: 'z',
    primaryModifier: true,
    shift: true,
    native: { menu: 'edit', lockSafe: false, queueable: false },
  },
  {
    id: 'album.membership.add',
    label: label('album.membership.add', 'Add to album'),
    surfaces: [],
    target: 'selection',
    native: { menu: 'photo', lockSafe: false, queueable: false },
    quickAction: { icon: 'album', availability: 'library', target: 'selection-if-included' },
  },
  {
    id: 'album.membership.remove',
    label: label('album.membership.remove', 'Remove from album'),
    surfaces: [],
    target: 'selection',
    native: { menu: 'photo', lockSafe: false, queueable: false },
  },
  { id: 'album.rename', label: label('album.rename', 'Rename album…'), surfaces: [], target: 'focused-item' },
  { id: 'album.delete', label: label('album.delete', 'Delete album…'), surfaces: [], target: 'focused-item' },
  { id: 'album.transfer', label: label('album.transfer', 'Transfer & Sync…'), surfaces: [], target: 'focused-item' },
  { id: 'album.hide', label: label('album.hide', 'Hide from All Photos'), surfaces: [], target: 'focused-item' },
  { id: 'album.show', label: label('album.show', 'Show in All Photos'), surfaces: [], target: 'focused-item' },
  { id: 'album.folder.new', label: label('album.folder.new', 'New folder…'), surfaces: [], target: 'focused-item' },
  { id: 'album.move', label: label('album.move', 'Move to folder…'), surfaces: [], target: 'focused-item' },
  { id: 'album.tags', label: label('album.tags', 'Tags…'), surfaces: [], target: 'focused-item' },
  { id: 'album.visibility.inherit', label: label('album.visibility.inherit', 'Use folder setting'), surfaces: [], target: 'focused-item' },
  { id: 'album.smart.new', label: label('album.smart.new', 'Save as Smart Album…'), surfaces: [], target: 'focused-item' },
  { id: 'album.smart.edit', label: label('album.smart.edit', 'Edit Smart Album'), surfaces: [], target: 'focused-item' },
  { id: 'album.duplicate', label: label('album.duplicate', 'Duplicate'), surfaces: [], target: 'focused-item' },
  { id: 'album.reorder.up', label: label('album.reorder.up', 'Move up'), surfaces: [], target: 'focused-item', key: 'ArrowUp', alt: true },
  {
    id: 'album.reorder.down',
    label: label('album.reorder.down', 'Move down'),
    surfaces: [],
    target: 'focused-item',
    key: 'ArrowDown',
    alt: true,
  },
  { id: 'album.reorder.top', label: label('album.reorder.top', 'Move to top'), surfaces: [], target: 'focused-item' },
  { id: 'album.reorder.bottom', label: label('album.reorder.bottom', 'Move to bottom'), surfaces: [], target: 'focused-item' },
  {
    id: 'view.inspector.toggle',
    label: label('view.inspector.toggle', 'Show or hide Inspector'),
    surfaces: ['grid', 'lightbox'],
    target: 'window',
    key: 'i',
    native: { menu: 'view', lockSafe: false, queueable: false },
  },
  {
    id: 'view.inspector.detach',
    label: label('view.inspector.detach', 'Open Inspector in Separate Window'),
    surfaces: ['grid', 'lightbox'],
    target: 'window',
    key: 'i',
    primaryModifier: true,
    shift: true,
    native: { menu: 'view', lockSafe: false, queueable: false },
  },
  {
    id: 'view.sidebar.toggle',
    label: label('view.sidebar.toggle', 'Toggle Sidebar'),
    surfaces: [],
    target: 'window',
    native: { menu: 'view', lockSafe: false, queueable: false },
  },
  {
    id: 'view.appearance.reset',
    label: label('view.appearance.reset', 'Reset Appearance'),
    surfaces: GLOBAL_SURFACES,
    target: 'application',
    key: 'r',
    primaryModifier: true,
    alt: true,
    shift: true,
    native: { menu: 'view', lockSafe: true, queueable: false },
  },
  {
    id: 'view.mode.grid',
    label: label('view.mode.grid', 'Grid'),
    surfaces: [],
    target: 'window',
    native: { menu: 'view', lockSafe: false, queueable: true },
  },
  {
    id: 'view.mode.list',
    label: label('view.mode.list', 'List'),
    surfaces: [],
    target: 'window',
    native: { menu: 'view', lockSafe: false, queueable: true },
  },
  {
    // As Feed projects the view state (#689). The Feed view has not landed
    // yet, so its menu item stays disabled rather than hardcoding a dead radio.
    // (Moodboard landed with #515 and is enabled below.)
    id: 'view.mode.feed',
    label: label('view.mode.feed', 'Feed'),
    surfaces: [],
    target: 'window',
    native: { menu: 'view', lockSafe: false, queueable: true },
  },
  {
    id: 'view.mode.moodboard',
    label: label('view.mode.moodboard', 'Moodboard'),
    surfaces: [],
    target: 'window',
    native: { menu: 'view', lockSafe: false, queueable: true },
  },
  {
    // The undoable moodboard layout edit (#695). Not exposed in a menu — it is
    // the identity under which per-gesture board changes record undo history
    // (ADR-0024/0025); the gestures themselves are keyboard-operable in-view.
    id: 'board.layout',
    label: label('board.layout', 'Edit board'),
    surfaces: [],
    target: 'focused-item',
  },
  {
    id: 'view.lightbox.close',
    label: label('view.lightbox.close', 'Exit lightbox'),
    surfaces: ['lightbox'],
    target: 'window',
    key: 'Escape',
    native: { menu: 'view', lockSafe: false, queueable: false },
  },
  {
    id: 'view.lightbox.previous',
    label: label('view.lightbox.previous', 'Previous photo'),
    surfaces: ['lightbox'],
    target: 'focused-item',
    key: 'ArrowLeft',
  },
  {
    id: 'view.lightbox.next',
    label: label('view.lightbox.next', 'Next photo'),
    surfaces: ['lightbox'],
    target: 'focused-item',
    key: 'ArrowRight',
  },
  {
    id: 'photo.favorite.toggle',
    label: label('photo.favorite.toggle', 'Toggle favorite'),
    surfaces: ['lightbox'],
    target: 'focused-item',
    key: 'f',
    native: { menu: 'photo', lockSafe: false, queueable: false },
    quickAction: { icon: 'star', availability: 'anywhere', target: 'photo' },
  },
  // Persisted edits (#493): resolved on the lightbox surface, executed by the viewport.
  {
    id: 'photo.edit.save',
    label: label('photo.edit.save', 'Save edits'),
    surfaces: ['lightbox'],
    target: 'focused-item',
    key: 's',
    primaryModifier: true,
  },
  { id: 'photo.edit.reset', label: label('photo.edit.reset', 'Reset edits'), surfaces: ['lightbox'], target: 'focused-item' },
  { id: 'photo.edit.crop', label: label('photo.edit.crop', 'Crop'), surfaces: ['lightbox'], target: 'focused-item', key: 'c' },
  { id: 'photo.edit.revert', label: label('photo.edit.revert', 'Revert to previous edit'), surfaces: ['lightbox'], target: 'focused-item' },
  {
    id: 'photo.original.mark',
    label: label('photo.original.mark', 'Mark as Original'),
    surfaces: [],
    target: 'selection',
  },
  {
    id: 'photo.original.unmark',
    label: label('photo.original.unmark', 'Remove Original protection'),
    surfaces: [],
    target: 'selection',
  },
  {
    id: 'photo.export',
    label: label('photo.export', 'Export…'),
    surfaces: [],
    target: 'selection',
    key: 'e',
    primaryModifier: true,
    shift: true,
    native: { menu: 'photo', lockSafe: false, queueable: false },
    quickAction: { icon: 'share', availability: 'anywhere', target: 'selection-if-included' },
  },
  { id: 'photo.open', label: label('photo.open', 'Open'), surfaces: [], target: 'focused-item' },
  // Variants (#496, ADR-0031 §3): a sibling variant over the same original.
  { id: 'photo.duplicate', label: label('photo.duplicate', 'Duplicate'), surfaces: [], target: 'selection' },
  { id: 'photo.offload', label: label('photo.offload', 'Offload original…'), surfaces: [], target: 'selection' },
  { id: 'photo.restoreOriginal', label: label('photo.restoreOriginal', 'Restore original'), surfaces: [], target: 'selection' },
  { id: 'photo.transfer', label: label('photo.transfer', 'Transfer & Sync…'), surfaces: [], target: 'selection' },
  {
    id: 'photo.trash',
    label: label('photo.trash', 'Move photo to Trash'),
    surfaces: ['lightbox'],
    target: 'focused-item',
    key: 'Delete',
    native: { menu: 'photo', lockSafe: false, queueable: false },
    quickAction: { icon: 'trash-2', availability: 'library', target: 'selection-if-included' },
  },
  {
    id: 'photo.restore',
    label: label('photo.restore', 'Restore photo'),
    surfaces: [],
    target: 'selection',
    native: { menu: 'photo', lockSafe: false, queueable: false },
    quickAction: { icon: 'refresh-cw', availability: 'trash', target: 'selection-if-included' },
  },
  {
    id: 'photo.purge',
    label: label('photo.purge', 'Delete permanently…'),
    surfaces: ['grid', 'lightbox'],
    target: 'selection',
    key: 'Delete',
    shift: true,
  },
  { id: 'trash.empty', label: label('trash.empty', 'Empty Trash…'), surfaces: [], target: 'route' },
  {
    id: 'view.lightbox.zoomIn',
    label: label('view.lightbox.zoomIn', 'Zoom in'),
    surfaces: ['lightbox'],
    target: 'focused-item',
    key: '+',
    alternateKeys: ['='],
  },
  {
    id: 'view.lightbox.zoomOut',
    label: label('view.lightbox.zoomOut', 'Zoom out'),
    surfaces: ['lightbox'],
    target: 'focused-item',
    key: '-',
    alternateKeys: ['_'],
  },
  {
    id: 'view.lightbox.zoomReset',
    label: label('view.lightbox.zoomReset', 'Reset zoom'),
    surfaces: ['lightbox'],
    target: 'focused-item',
    key: '0',
  },
  {
    id: 'view.lightbox.rotateRight',
    label: label('view.lightbox.rotateRight', 'Rotate clockwise'),
    surfaces: ['lightbox'],
    target: 'focused-item',
    key: 'R',
    code: 'KeyR',
  },
  {
    id: 'view.lightbox.rotateLeft',
    label: label('view.lightbox.rotateLeft', 'Rotate counterclockwise'),
    surfaces: ['lightbox'],
    target: 'focused-item',
    key: 'R',
    code: 'KeyR',
    alt: true,
  },
  {
    id: 'view.lightbox.flipHorizontal',
    label: label('view.lightbox.flipHorizontal', 'Flip horizontally'),
    surfaces: ['lightbox'],
    target: 'focused-item',
    key: 'H',
    code: 'KeyH',
  },
  {
    id: 'view.lightbox.flipVertical',
    label: label('view.lightbox.flipVertical', 'Flip vertically'),
    surfaces: ['lightbox'],
    target: 'focused-item',
    key: 'H',
    code: 'KeyH',
    alt: true,
  },
  {
    id: 'view.lightbox.orientationReset',
    label: label('view.lightbox.orientationReset', 'Reset orientation'),
    surfaces: ['lightbox'],
    target: 'focused-item',
    key: 'R',
    code: 'KeyR',
    shift: true,
  },
  {
    id: 'help.shortcuts',
    label: label('help.shortcuts', 'Keyboard shortcuts'),
    surfaces: GLOBAL_SURFACES,
    target: 'window',
    key: '?',
    alternateKeys: ['/'],
    native: { menu: 'help', lockSafe: true, queueable: true },
  },
  {
    id: 'help.activity',
    label: label('help.activity', 'Activity…'),
    // Menu-only command surface (ADR-0024/ADR-0025): reached from Help, never a
    // library source or album row. The design system gives it no accelerator,
    // so it carries no key — the native Help menu supplies keyboard access.
    surfaces: [],
    target: 'window',
    native: { menu: 'help', lockSafe: false, queueable: true },
  },
  {
    id: 'help.open',
    label: label('help.open', 'Overlook Help'),
    surfaces: [],
    target: 'application',
    native: { menu: 'help', lockSafe: true, queueable: false },
  },
  gridFocus('grid.focus.left', 'Move focus left', 'ArrowLeft'),
  gridFocus('grid.focus.right', 'Move focus right', 'ArrowRight'),
  gridFocus('grid.focus.up', 'Move focus up', 'ArrowUp'),
  gridFocus('grid.focus.down', 'Move focus down', 'ArrowDown'),
  gridFocus('grid.focus.home', 'Move to row start', 'Home'),
  gridFocus('grid.focus.end', 'Move to row end', 'End'),
  gridFocus('grid.focus.pageUp', 'Move up one page', 'PageUp'),
  gridFocus('grid.focus.pageDown', 'Move down one page', 'PageDown'),
];

function normalizedKey(key: string): string {
  return key.length === 1 && key !== '?' ? key.toLocaleLowerCase('en-US') : key;
}

function primaryPressed(event: KeyboardLike, platform: CommandPlatform): boolean {
  return platform === 'darwin' ? event.metaKey === true : event.ctrlKey === true;
}

function matches(command: CommandDescriptor, event: KeyboardLike, platform: CommandPlatform): boolean {
  if (command.key === undefined) return false;
  const keys = [command.key, ...(command.alternateKeys ?? [])];
  const keyMatches =
    command.code === undefined ? keys.some((key) => normalizedKey(event.key) === normalizedKey(key)) : event.code === command.code;
  if (!keyMatches) return false;
  if (primaryPressed(event, platform) !== (command.primaryModifier === true)) return false;
  const printableSymbol = event.key.length === 1 && !/[a-z0-9]/iu.test(event.key);
  if ((command.code !== undefined || !printableSymbol) && (event.shiftKey === true) !== (command.shift === true)) return false;
  if ((event.altKey === true) !== (command.alt === true)) return false;
  if (platform === 'darwin' ? event.ctrlKey === true : event.metaKey === true) return false;
  return true;
}

export function activeShortcuts(context: CommandContext): readonly CommandDescriptor[] {
  if (context.dialogOpen || context.editable || context.surface === 'dialog') return [];
  return COMMANDS.filter((command) => command.surfaces.includes(context.surface));
}

export function findShortcutConflicts(commands: readonly CommandDescriptor[]): readonly string[] {
  const seen = new Map<string, CommandId>();
  const conflicts: string[] = [];
  for (const command of commands) {
    if (command.key === undefined) continue;
    for (const surface of command.surfaces) {
      for (const key of [command.key, ...(command.alternateKeys ?? [])]) {
        const binding = `${surface}:${command.primaryModifier === true ? 'primary+' : ''}${command.alt === true ? 'alt+' : ''}${command.shift === true ? 'shift+' : ''}${command.code ?? normalizedKey(key)}`;
        const prior = seen.get(binding);
        if (prior === undefined) seen.set(binding, command.id);
        else conflicts.push(`${binding}: ${prior}, ${command.id}`);
      }
    }
  }
  return conflicts;
}

export function resolveCommand(event: KeyboardLike, context: CommandContext): CommandDescriptor | null {
  return activeShortcuts(context).find((command) => matches(command, event, context.platform)) ?? null;
}

export function formatShortcut(command: CommandDescriptor, platform: CommandPlatform): string {
  if (command.key === undefined) return '';
  const parts: string[] = [];
  if (command.primaryModifier === true) parts.push(platform === 'darwin' ? '⌘' : 'Ctrl+');
  if (command.alt === true) parts.push(platform === 'darwin' ? '⌥' : 'Alt+');
  if (command.shift === true) parts.push(platform === 'darwin' ? '⇧' : 'Shift+');
  const display =
    command.key === 'ArrowLeft'
      ? '←'
      : command.key === 'ArrowRight'
        ? '→'
        : command.key === 'ArrowUp'
          ? '↑'
          : command.key === 'ArrowDown'
            ? '↓'
            : command.key.length === 1
              ? command.key.toLocaleUpperCase('en-US')
              : command.key;
  parts.push(display);
  return parts.join('');
}

export function formatAriaShortcut(command: CommandDescriptor, platform: CommandPlatform): string {
  if (command.key === undefined) return '';
  const parts: string[] = [];
  if (command.primaryModifier === true) parts.push(platform === 'darwin' ? 'Meta' : 'Control');
  if (command.alt === true) parts.push('Alt');
  if (command.shift === true) parts.push('Shift');
  parts.push(command.key);
  return parts.join('+');
}

export function commandById(id: CommandId): CommandDescriptor {
  const command = COMMANDS.find((candidate) => candidate.id === id);
  if (command === undefined) throw new Error(`unknown command: ${id}`);
  return command;
}

export function nativeCommands(menu?: NativeMenu): readonly CommandDescriptor[] {
  return COMMANDS.filter((command) => command.native !== undefined && (menu === undefined || command.native.menu === menu));
}

export type QuickActionCommandId = Extract<
  CommandId,
  'album.membership.add' | 'photo.export' | 'photo.favorite.toggle' | 'photo.restore' | 'photo.trash'
>;

export const QUICK_ACTION_COMMANDS: readonly (CommandDescriptor & {
  readonly id: QuickActionCommandId;
  readonly quickAction: QuickActionExposure;
})[] = COMMANDS.filter(
  (command): command is CommandDescriptor & { readonly id: QuickActionCommandId; readonly quickAction: QuickActionExposure } =>
    command.quickAction !== undefined,
);

export const QUICK_ACTION_IDS: readonly QuickActionCommandId[] = QUICK_ACTION_COMMANDS.map(({ id }) => id);

export function isQuickActionCommandId(value: string): value is QuickActionCommandId {
  return QUICK_ACTION_IDS.includes(value as QuickActionCommandId);
}
