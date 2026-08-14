import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isAbsoluteImportPath, requireMoveImportConfirmation } from '../../src/main/import/import-move-confirmation.js';

describe('Move import confirmation boundary', () => {
  test('copy imports do not require destructive authorization', async () => {
    let prompted = false;
    const confirmed = await requireMoveImportConfirmation('copy', { path: '/card' }, () => {
      prompted = true;
      return Promise.resolve(false);
    });
    assert.equal(prompted, false);
    assert.equal(confirmed, true);
  });

  test('returns cancellation unless main confirms the exact Move request', async () => {
    const source = { files: ['/drop/a.jpg', '/drop/b.jpg'] };
    let confirmedSource: unknown;
    assert.equal(await requireMoveImportConfirmation('move', source), false);
    assert.equal(
      await requireMoveImportConfirmation('move', source, (candidate) => {
        confirmedSource = candidate;
        return Promise.resolve(false);
      }),
      false,
    );
    assert.deepEqual(confirmedSource, source);
    assert.equal(await requireMoveImportConfirmation('move', source, () => Promise.resolve(true)), true);
  });

  test('rejects relative Move sources before prompting', async () => {
    let prompted = false;
    await assert.rejects(
      requireMoveImportConfirmation('move', { files: ['/drop/a.jpg', '../outside.jpg'] }, () => {
        prompted = true;
        return Promise.resolve(true);
      }),
      /absolute paths/u,
    );
    assert.equal(prompted, false);
  });

  test('Windows Move sources require a drive or UNC root', () => {
    assert.equal(isAbsoluteImportPath('/Pictures', 'win32'), false);
    assert.equal(isAbsoluteImportPath('\\Pictures', 'win32'), false);
    assert.equal(isAbsoluteImportPath('C:Pictures', 'win32'), false);
    assert.equal(isAbsoluteImportPath('C:\\Pictures', 'win32'), true);
    assert.equal(isAbsoluteImportPath('\\\\server\\share\\Pictures', 'win32'), true);
  });
});
