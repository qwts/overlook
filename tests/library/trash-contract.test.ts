import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { destructiveActions } from '../../src/shared/destructive-actions.js';
import { DEFAULT_TRASH_RETENTION, trashDaysRemaining, trashRetentionDays, trashRetentionLabel } from '../../src/shared/library/trash.js';

describe('ADR-0023 destructive action contract', () => {
  test('registry identifiers are unique and irreversible actions describe their side effects', () => {
    const actions = Object.values(destructiveActions);
    assert.equal(new Set(actions.map((action) => action.id)).size, actions.length);
    for (const action of actions) {
      if (action.tier !== 'irreversible') continue;
      assert.ok('sideEffects' in action && action.sideEffects.length > 0);
      assert.match(action.label, /permanently/u);
    }
  });

  test('reversible and structural actions state what survives', () => {
    for (const action of Object.values(destructiveActions)) {
      if (action.tier === 'irreversible') continue;
      assert.ok('survival' in action && action.survival.length > 0);
    }
  });

  test('Off / 7 / 30 / 90 retention boundaries share one countdown contract', () => {
    const now = Date.parse('2026-07-20T12:00:00.000Z');
    assert.equal(DEFAULT_TRASH_RETENTION, '30');
    assert.equal(trashRetentionDays('off'), null);
    assert.equal(trashRetentionLabel('2026-01-01T00:00:00.000Z', 'off', now), 'Kept until deleted manually');
    for (const retention of ['7', '30', '90'] as const) {
      const days = Number(retention);
      assert.equal(trashRetentionDays(retention), days);
      assert.equal(trashDaysRemaining('2026-07-20T12:00:00.000Z', retention, now), days);
      assert.equal(trashDaysRemaining('2026-07-19T11:59:59.999Z', retention, now), days - 1);
      assert.equal(
        trashRetentionLabel(new Date(now - days * 24 * 60 * 60 * 1000).toISOString(), retention, now),
        'Deletes permanently today',
      );
    }
  });
});
