import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { requireMoveImportConfirmation } from '../../src/main/ipc.js';

describe('Move import confirmation boundary', () => {
  test('copy imports do not require destructive authorization', async () => {
    let prompted = false;
    await requireMoveImportConfirmation('copy', { path: '/card' }, () => {
      prompted = true;
      return Promise.resolve(false);
    });
    assert.equal(prompted, false);
  });

  test('rejects renderer-requested Move unless main confirms that exact request', async () => {
    const source = { files: ['/drop/a.jpg', '/drop/b.jpg'] };
    let confirmedSource: unknown;
    await assert.rejects(requireMoveImportConfirmation('move', source), /requires main-process confirmation/u);
    await assert.rejects(
      requireMoveImportConfirmation('move', source, (candidate) => {
        confirmedSource = candidate;
        return Promise.resolve(false);
      }),
      /requires main-process confirmation/u,
    );
    assert.deepEqual(confirmedSource, source);
    await requireMoveImportConfirmation('move', source, () => Promise.resolve(true));
  });
});
