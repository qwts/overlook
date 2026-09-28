import { commandById, formatAriaShortcut, formatShortcut, type CommandId, type CommandPlatform } from './registry.js';
import type { CommandMenuContext } from './menu-contract.js';
import { commandEnabled } from './menu-enablement.js';

// The Windows/Linux titlebar "Overlook menu" (⋯, #1293; ADR-0024 §5 second
// amendment, #1314): the macOS File, Edit, View, and Overlook commands that
// have no other visible surface there. Same shape as `help-menu.ts` — this
// module fixes membership, grouping, and order; labels, enablement, and
// shortcuts still come from the command registry and `commandEnabled`.

interface MessageDescriptor {
  readonly id: string;
  readonly defaultMessage: string;
}

const defineMessages = <T extends Record<string, MessageDescriptor>>(messages: T): T => messages;

/** Menu headings shared by the macOS menu bar and the titlebar menu groups. */
export const menuMessages = defineMessages({
  app: { id: 'menu.app', defaultMessage: 'Overlook' },
  file: { id: 'menu.file', defaultMessage: 'File' },
  edit: { id: 'menu.edit', defaultMessage: 'Edit' },
  view: { id: 'menu.view', defaultMessage: 'View' },
  photo: { id: 'menu.photo', defaultMessage: 'Photo' },
});

const disabledReasons = defineMessages({
  protectedAlbumOpen: {
    id: 'menu.app.disabled.protectedAlbumOpen',
    defaultMessage: 'Not available while a protected album is open',
  },
});

export type AppMenuGroupId = 'file' | 'edit' | 'view' | 'app';

export interface AppMenuEntry {
  readonly command: CommandId;
  /** Shown only when this holds; otherwise the command has no place here. */
  readonly showWhen?: 'pcloudEnabled' | 'appLockConfigured';
}

export interface AppMenuGroup {
  readonly id: AppMenuGroupId;
  readonly heading: MessageDescriptor;
  readonly entries: readonly AppMenuEntry[];
}

export const APP_MENU_GROUPS: readonly AppMenuGroup[] = [
  {
    id: 'file',
    heading: menuMessages.file,
    entries: [{ command: 'library.import' }, { command: 'library.exportAll' }, { command: 'library.duplicates' }],
  },
  {
    id: 'edit',
    heading: menuMessages.edit,
    entries: [{ command: 'history.undo' }, { command: 'history.redo' }, { command: 'selection.selectAll' }],
  },
  {
    id: 'view',
    heading: menuMessages.view,
    entries: [
      { command: 'view.sidebar.toggle' },
      { command: 'view.inspector.toggle' },
      { command: 'view.inspector.detach' },
      { command: 'view.appearance.reset' },
    ],
  },
  {
    id: 'app',
    heading: menuMessages.app,
    entries: [
      { command: 'app.settings.open' },
      { command: 'app.settings.open.storage' },
      { command: 'app.settings.open.transfer', showWhen: 'pcloudEnabled' },
      { command: 'app.lock.now', showWhen: 'appLockConfigured' },
    ],
  },
];

/** Every command the ⋯ menu can show, in menu order. */
export const APP_MENU_ITEMS: readonly CommandId[] = APP_MENU_GROUPS.flatMap((group) => group.entries.map((entry) => entry.command));

export interface AppMenuItemModel {
  readonly command: CommandId;
  readonly enabled: boolean;
  /** Why a disabled item can't run, when there is a reason worth saying. */
  readonly disabledReason?: MessageDescriptor | undefined;
}

export interface AppMenuGroupModel {
  readonly id: AppMenuGroupId;
  readonly heading: MessageDescriptor;
  readonly items: readonly AppMenuItemModel[];
}

function disabledReason(command: CommandId, context: CommandMenuContext): MessageDescriptor | undefined {
  if (command === 'library.exportAll' && context.protectedAlbumOpen) return disabledReasons.protectedAlbumOpen;
  return undefined;
}

/** The menu for a context: conditional commands appear only when they apply,
 *  a locked app shows only lock-safe commands, and everything else stays in
 *  place, disabled when `commandEnabled` says so. Empty groups drop out. */
export function appMenuModel(context: CommandMenuContext): readonly AppMenuGroupModel[] {
  const locked = context.surface === 'locked';
  return APP_MENU_GROUPS.map((group) => ({
    id: group.id,
    heading: group.heading,
    items: group.entries
      .filter((entry) => entry.showWhen === undefined || context[entry.showWhen])
      .filter((entry) => !locked || commandById(entry.command).native?.lockSafe === true)
      .map((entry) => {
        const enabled = commandEnabled(entry.command, context);
        return { command: entry.command, enabled, disabledReason: enabled ? undefined : disabledReason(entry.command, context) };
      }),
  })).filter((group) => group.items.length > 0);
}

export interface AppMenuShortcut {
  readonly label: string;
  readonly aria: string;
}

/** The shortcut the ⋯ menu shows beside a command, if any. Windows and Linux
 *  have no native menu accelerators, so only a binding the renderer's keyboard
 *  dispatcher resolves (on the grid or lightbox) counts: a macOS-only menu
 *  accelerator such as Import's would advertise a key that does nothing. */
export function appMenuShortcut(id: CommandId, platform: CommandPlatform): AppMenuShortcut | undefined {
  const command = commandById(id);
  if (!command.surfaces.some((surface) => surface === 'grid' || surface === 'lightbox')) return undefined;
  const label = formatShortcut(command, platform);
  return label === '' ? undefined : { label, aria: formatAriaShortcut(command, platform) };
}
