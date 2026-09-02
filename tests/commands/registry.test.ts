import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMANDS,
  QUICK_ACTION_COMMANDS,
  activeShortcuts,
  commandById,
  findShortcutConflicts,
  formatAriaShortcut,
  formatShortcut,
  nativeCommands,
  resolveCommand,
  type CommandContext,
} from '../../src/shared/commands/registry.js';

const gridContext: CommandContext = {
  surface: 'grid',
  dialogOpen: false,
  editable: false,
  platform: 'darwin',
};

test('command registry has stable unique IDs and no active binding conflicts (#399)', () => {
  assert.equal(new Set(COMMANDS.map(({ id }) => id)).size, COMMANDS.length);
  assert.deepEqual(findShortcutConflicts(COMMANDS), []);
});

test('Quick Actions are a bounded command-registry projection with stable UI metadata (#532)', () => {
  assert.deepEqual(
    QUICK_ACTION_COMMANDS.map(({ id }) => id),
    ['album.membership.add', 'photo.favorite.toggle', 'photo.export', 'photo.trash', 'photo.restore'],
  );
  assert.ok(QUICK_ACTION_COMMANDS.length <= 5);
  assert.ok(QUICK_ACTION_COMMANDS.every(({ quickAction }) => quickAction.icon.length > 0));
});

test('context resolution protects fields and gives the lightbox arrow precedence (#399)', () => {
  assert.equal(resolveCommand({ key: 'a', metaKey: true }, gridContext)?.id, 'selection.selectAll');
  assert.equal(resolveCommand({ key: 'i' }, gridContext)?.id, 'view.inspector.toggle');
  assert.equal(resolveCommand({ key: 'i', metaKey: true, shiftKey: true }, gridContext)?.id, 'view.inspector.detach');
  assert.equal(resolveCommand({ key: '?' }, gridContext)?.id, 'help.shortcuts');
  assert.equal(resolveCommand({ key: '/', shiftKey: true }, gridContext)?.id, 'help.shortcuts');

  assert.equal(resolveCommand({ key: 'a', metaKey: true }, { ...gridContext, editable: true }), null);
  assert.equal(resolveCommand({ key: 'i' }, { ...gridContext, editable: true }), null);
  assert.equal(resolveCommand({ key: 'i', metaKey: true, shiftKey: true }, { ...gridContext, editable: true }), null);
  assert.equal(resolveCommand({ key: 'Delete', shiftKey: true }, gridContext)?.id, 'photo.purge');
  assert.equal(resolveCommand({ key: 'Delete', shiftKey: true }, { ...gridContext, editable: true }), null);
  assert.equal(resolveCommand({ key: 'Delete', shiftKey: true }, { ...gridContext, dialogOpen: true }), null);
  assert.equal(resolveCommand({ key: 'ArrowRight' }, { ...gridContext, surface: 'lightbox' })?.id, 'view.lightbox.next');
  assert.equal(resolveCommand({ key: 'k', metaKey: true }, { ...gridContext, surface: 'lightbox' }), null);
  assert.equal(resolveCommand({ key: 'ArrowRight' }, gridContext)?.id, 'grid.focus.right');
  assert.equal(resolveCommand({ key: 'ArrowRight' }, { ...gridContext, dialogOpen: true }), null);
});

test('shortcut help is generated from the active registry projection (#399)', () => {
  const ids = activeShortcuts(gridContext).map(({ id }) => id);
  assert.ok(ids.includes('selection.selectAll'));
  assert.ok(ids.includes('grid.focus.right'));
  assert.ok(!ids.includes('view.lightbox.next'));
  assert.equal(
    formatShortcut(
      COMMANDS.find(({ id }) => id === 'selection.selectAll')!,
      'darwin',
    ),
    '⌘A',
  );
  assert.equal(
    formatShortcut(
      COMMANDS.find(({ id }) => id === 'selection.selectAll')!,
      'win32',
    ),
    'Ctrl+A',
  );
});

test('native menu exposure is typed, unique, and queues only idempotent commands (#531)', () => {
  const native = nativeCommands();
  assert.ok(native.some(({ id }) => id === 'app.settings.open.privacy'));
  assert.ok(native.some(({ id }) => id === 'library.source.trash'));
  assert.equal(commandById('app.settings.open').native?.lockSafe, true);
  assert.equal(commandById('app.settings.open').native?.queueable, true);
  assert.equal(commandById('app.lock.now').native?.queueable, false);
  assert.equal(commandById('photo.trash').native?.queueable, false);
  assert.equal(commandById('help.open').target, 'application');
  assert.ok(
    native
      .filter(({ native: exposure }) => exposure?.queueable === true)
      .every(({ target }) => target !== 'focused-item' && target !== 'selection'),
  );
});

test('transient orientation commands use physical keys and Option/Alt inverse bindings (#510)', () => {
  const lightbox = { ...gridContext, surface: 'lightbox' as const };

  assert.equal(resolveCommand({ key: 'r', code: 'KeyR' }, lightbox)?.id, 'view.lightbox.rotateRight');
  assert.equal(resolveCommand({ key: 'r', code: 'KeyR', altKey: true }, lightbox)?.id, 'view.lightbox.rotateLeft');
  assert.equal(resolveCommand({ key: 'h', code: 'KeyH' }, lightbox)?.id, 'view.lightbox.flipHorizontal');
  assert.equal(resolveCommand({ key: 'h', code: 'KeyH', altKey: true }, lightbox)?.id, 'view.lightbox.flipVertical');

  assert.equal(resolveCommand({ key: 'р', code: 'KeyR' }, lightbox)?.id, 'view.lightbox.rotateRight');
  assert.equal(resolveCommand({ key: 'р', code: 'KeyR', altKey: true }, lightbox)?.id, 'view.lightbox.rotateLeft');
  assert.equal(resolveCommand({ key: '®', code: 'KeyR', altKey: true, shiftKey: true }, lightbox), null);
  assert.equal(resolveCommand({ key: 'r', code: 'KeyR' }, { ...lightbox, editable: true }), null);
  assert.equal(resolveCommand({ key: 'r', code: 'KeyR' }, { ...lightbox, dialogOpen: true }), null);

  const inverse = COMMANDS.find(({ id }) => id === 'view.lightbox.rotateLeft')!;
  assert.equal(formatShortcut(inverse, 'darwin'), '⌥R');
  assert.equal(formatShortcut(inverse, 'win32'), 'Alt+R');
  assert.equal(formatAriaShortcut(inverse, 'darwin'), 'Alt+R');
});

test('persisted-edit commands resolve only on the lightbox surface (#493)', () => {
  const lightbox: CommandContext = { ...gridContext, surface: 'lightbox' };
  assert.equal(resolveCommand({ key: 's', metaKey: true }, lightbox)?.id, 'photo.edit.save');
  assert.equal(resolveCommand({ key: 'c' }, lightbox)?.id, 'photo.edit.crop');
  assert.notEqual(resolveCommand({ key: 's', metaKey: true }, gridContext)?.id, 'photo.edit.save');
  assert.notEqual(resolveCommand({ key: 'c' }, gridContext)?.id, 'photo.edit.crop');
  assert.equal(resolveCommand({ key: 's', metaKey: true }, { ...lightbox, editable: true }), null);
  assert.equal(resolveCommand({ key: 's', ctrlKey: true }, { ...lightbox, platform: 'win32' })?.id, 'photo.edit.save');
  assert.match(formatShortcut(commandById('photo.edit.save'), 'darwin'), /S$/u);
  // Reset and Revert are toolbar-only: no key, so nothing to conflict with.
  assert.equal(commandById('photo.edit.reset').key, undefined);
  assert.equal(commandById('photo.edit.revert').key, undefined);
  for (const id of ['photo.edit.save', 'photo.edit.reset', 'photo.edit.crop', 'photo.edit.revert'] as const) {
    assert.deepEqual(commandById(id).surfaces, ['lightbox']);
  }
});
