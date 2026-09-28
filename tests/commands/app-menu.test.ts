import assert from 'node:assert/strict';
import test from 'node:test';
import type { MenuItemConstructorOptions } from 'electron';

import { buildApplicationMenuTemplate } from '../../src/main/application-menu-model.js';
import { APP_MENU_ITEMS, appMenuModel, appMenuShortcut } from '../../src/shared/commands/app-menu.js';
import { HELP_MENU_ITEMS } from '../../src/shared/commands/help-menu.js';
import { EMPTY_COMMAND_MENU_CONTEXT, type CommandMenuContext } from '../../src/shared/commands/menu-contract.js';
import { commandEnabled } from '../../src/shared/commands/menu-enablement.js';
import { commandById, resolveCommand, type CommandId } from '../../src/shared/commands/registry.js';

// #1293 (Pass B spec §04, §08; ADR-0024 §5 second amendment): the Windows/Linux
// ⋯ Overlook menu gives every non-Photo macOS menu command a visible surface.

const grid: CommandMenuContext = {
  ...EMPTY_COMMAND_MENU_CONTEXT,
  surface: 'grid',
  hasLibrary: true,
  hasPhotos: true,
  hasPhotoKeyTarget: true,
  appLockConfigured: true,
  pcloudEnabled: true,
};

// macOS menu commands that already have a visible Windows/Linux surface
// outside the titlebar menus (spec §05).
const OTHER_SURFACES: Readonly<Partial<Record<CommandId, string>>> = {
  'photo.export': 'selection pill and photo context menu',
  'library.switch': 'titlebar library switcher',
  'library.move': 'titlebar library switcher',
  'library.new': 'titlebar library switcher',
  'selection.clear': 'selection pill close button and Esc',
  'library.source.all': 'sidebar',
  'library.source.favorites': 'sidebar',
  'library.source.recent': 'sidebar',
  'library.source.trash': 'sidebar',
  'view.mode.grid': 'toolbar view control',
  'view.mode.list': 'toolbar view control',
  'view.mode.feed': 'toolbar view control',
  'view.mode.moodboard': 'toolbar view control',
};

// Native menu item ids that re-project a command under a second id.
const ALIASES: Readonly<Record<string, CommandId>> = { 'help.privacy': 'app.settings.open.privacy' };

function commandIds(items: readonly MenuItemConstructorOptions[]): CommandId[] {
  return items.flatMap((item) => [
    ...(item.id === undefined ? [] : [ALIASES[item.id] ?? (item.id as CommandId)]),
    ...(Array.isArray(item.submenu) ? commandIds(item.submenu) : []),
  ]);
}

test('every non-Photo macOS menu command has a Windows/Linux surface', () => {
  for (const context of [grid, { ...grid, editable: true }, { ...grid, source: 'deleted' as const }]) {
    const template = buildApplicationMenuTemplate('darwin', 'Overlook', context, () => {});
    const nonPhoto = template.filter((menu) => menu.label !== 'Photo');
    const help = new Set<CommandId>(HELP_MENU_ITEMS.map((entry) => entry.command));
    for (const id of commandIds(nonPhoto)) {
      assert.ok(APP_MENU_ITEMS.includes(id) || help.has(id) || OTHER_SURFACES[id] !== undefined, `${id} has no Windows/Linux surface`);
    }
  }
});

test('the ⋯ menu groups File · Edit · View · Overlook in the spec order', () => {
  const model = appMenuModel(grid);
  assert.deepEqual(
    model.map((group) => [group.heading.defaultMessage, group.items.map((item) => item.command)]),
    [
      ['File', ['library.import', 'library.exportAll', 'library.duplicates']],
      ['Edit', ['history.undo', 'history.redo', 'selection.selectAll']],
      ['View', ['view.sidebar.toggle', 'view.inspector.toggle', 'view.inspector.detach', 'view.appearance.reset']],
      ['Overlook', ['app.settings.open', 'app.settings.open.storage', 'app.settings.open.transfer', 'app.lock.now']],
    ],
  );
});

test('⋯ enablement is commandEnabled across contexts', () => {
  const contexts: readonly CommandMenuContext[] = [
    grid,
    { ...grid, surface: 'lightbox', hasTarget: true },
    { ...grid, dialog: 'settings' },
    { ...grid, editable: true },
    { ...grid, protectedAlbumOpen: true },
    { ...grid, hasLibrary: false, hasPhotos: false },
    { ...grid, providerBusy: true },
  ];
  for (const context of contexts) {
    for (const group of appMenuModel(context)) {
      for (const item of group.items) {
        assert.equal(item.enabled, commandEnabled(item.command, context), `${item.command} in ${JSON.stringify(context)}`);
        // Labels come from the registry; the model carries only the id.
        assert.ok(commandById(item.command).label.defaultMessage.length > 0);
      }
    }
  }
});

test('Transfer & Sync shows only with pCloud on, Lock Now only with a lock set up', () => {
  const items = (context: CommandMenuContext): CommandId[] =>
    appMenuModel(context).flatMap((group) => group.items.map((item) => item.command));
  assert.equal(items({ ...grid, pcloudEnabled: false }).includes('app.settings.open.transfer'), false);
  assert.equal(items({ ...grid, appLockConfigured: false }).includes('app.lock.now'), false);
  assert.equal(items(grid).includes('app.settings.open.transfer'), true);
  assert.equal(items(grid).includes('app.lock.now'), true);
});

test('Export All stays in the menu, disabled with its reason, while a protected album is open', () => {
  const file = appMenuModel({ ...grid, protectedAlbumOpen: true }).find((group) => group.id === 'file');
  const exportAll = file?.items.find((item) => item.command === 'library.exportAll');
  assert.equal(exportAll?.enabled, false);
  assert.equal(exportAll?.disabledReason?.defaultMessage, 'Not available while a protected album is open');
  const open = appMenuModel(grid)
    .find((group) => group.id === 'file')
    ?.items.find((item) => item.command === 'library.exportAll');
  assert.equal(open?.enabled, true);
  assert.equal(open?.disabledReason, undefined);
});

test('a locked app shows only lock-safe commands', () => {
  const locked = appMenuModel({ ...grid, surface: 'locked' });
  const commands = locked.flatMap((group) => group.items.map((item) => item.command));
  assert.ok(commands.length > 0);
  for (const command of commands) assert.equal(commandById(command).native?.lockSafe, true, command);
  assert.deepEqual(
    locked.map((group) => group.id),
    [...new Set(locked.map((group) => group.id))],
  );
});

test('every shortcut the ⋯ menu shows is one the renderer resolves on Windows and Linux', () => {
  for (const platform of ['win32', 'linux'] as const) {
    for (const id of APP_MENU_ITEMS) {
      const shortcut = appMenuShortcut(id, platform);
      if (shortcut === undefined) continue;
      const command = commandById(id);
      const event = {
        key: command.key ?? '',
        code: command.code,
        ctrlKey: command.primaryModifier === true,
        altKey: command.alt === true,
        shiftKey: command.shift === true,
      };
      const resolved = (['grid', 'lightbox'] as const).map(
        (surface) => resolveCommand(event, { surface, dialogOpen: false, editable: false, platform })?.id,
      );
      assert.ok(resolved.includes(id), `${id} shows ${shortcut.label} on ${platform} but no surface resolves it`);
    }
  }
  // Import's ⌘I is a macOS menu accelerator only; the ⋯ menu shows no key for it.
  assert.equal(appMenuShortcut('library.import', 'win32'), undefined);
  assert.deepEqual(appMenuShortcut('history.undo', 'win32'), { label: 'Ctrl+Z', aria: 'Control+z' });
});
