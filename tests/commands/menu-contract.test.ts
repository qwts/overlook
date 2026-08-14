import assert from 'node:assert/strict';
import test from 'node:test';

import { commandIdSchema, commandMenuContextSchema, EMPTY_COMMAND_MENU_CONTEXT } from '../../src/shared/commands/menu-contract.js';

test('native command bridge accepts only registered command ids (#531)', () => {
  assert.equal(commandIdSchema.parse('app.settings.open.privacy'), 'app.settings.open.privacy');
  assert.throws(() => commandIdSchema.parse('app.settings.open.secrets'));
});

test('native command context is bounded and contains no content metadata (#531)', () => {
  assert.deepEqual(commandMenuContextSchema.parse(EMPTY_COMMAND_MENU_CONTEXT), EMPTY_COMMAND_MENU_CONTEXT);
  assert.equal(commandMenuContextSchema.parse({ ...EMPTY_COMMAND_MENU_CONTEXT, selectionCount: 200_000 }).selectionCount, 200_000);
  assert.throws(() => commandMenuContextSchema.parse({ ...EMPTY_COMMAND_MENU_CONTEXT, fileName: 'private.jpg' }));
});
