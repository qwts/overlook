import assert from 'node:assert/strict';
import test from 'node:test';
import { photoCommandAvailability } from '../../src/shared/commands/photo-availability.js';

import {
  initialQuickActionVisibility,
  quickActionAvailability,
  quickActionTargetIds,
  reduceQuickActionVisibility,
} from '../../src/shared/commands/quick-actions.js';

test('Command-hover state is cleared on release and transient dismissal (#532)', () => {
  const held = reduceQuickActionVisibility(initialQuickActionVisibility, { type: 'modifier', held: true });
  const targeted = reduceQuickActionVisibility(held, { type: 'target', id: 'photo-1' });
  assert.deepEqual(targeted, { modifierHeld: true, targetId: 'photo-1' });
  assert.deepEqual(reduceQuickActionVisibility(targeted, { type: 'dismiss' }), {
    modifierHeld: true,
    targetId: null,
  });
  assert.deepEqual(reduceQuickActionVisibility(targeted, { type: 'modifier', held: false }), initialQuickActionVisibility);
});

test('selection actions use the selection only when it contains the surfaced photo (#532)', () => {
  const selection = ['photo-1', 'photo-2'];
  assert.deepEqual(quickActionTargetIds('photo.export', 'photo-1', selection), selection);
  assert.deepEqual(quickActionTargetIds('photo.export', 'photo-3', selection), ['photo-3']);
  assert.deepEqual(quickActionTargetIds('photo.favorite.toggle', 'photo-1', selection), ['photo-1']);
});

test('Trash-only and library-only commands explain disabled availability (#532)', () => {
  assert.deepEqual(quickActionAvailability('photo.trash', 'trash'), {
    enabled: false,
    reason: 'library-only',
  });
  assert.deepEqual(quickActionAvailability('photo.restore', 'library'), {
    enabled: false,
    reason: 'trash-only',
  });
  assert.deepEqual(quickActionAvailability('photo.export', 'trash'), { enabled: true, reason: null });
});

test('locked single-photo export is disabled while metadata Quick Actions remain available (#1133)', () => {
  assert.deepEqual(quickActionAvailability('photo.export', 'library', true), { enabled: false, reason: 'locked' });
  assert.deepEqual(quickActionAvailability('photo.export', 'trash', true), { enabled: false, reason: 'locked' });
  assert.deepEqual(quickActionAvailability('photo.export', 'library', false), { enabled: true, reason: null });
  assert.deepEqual(quickActionAvailability('photo.favorite.toggle', 'library', true), { enabled: true, reason: null });
  assert.deepEqual(quickActionAvailability('photo.trash', 'library', true), { enabled: true, reason: null });
});

test('single-photo custody policy preserves metadata commands and recovers when the key returns (#1133)', () => {
  for (const id of ['photo.export', 'photo.duplicate'] as const) {
    assert.deepEqual(photoCommandAvailability(id, true), { enabled: false, reason: 'locked' });
    assert.deepEqual(photoCommandAvailability(id, false), { enabled: true, reason: null });
  }
  for (const id of [
    'photo.open',
    'photo.favorite.toggle',
    'album.membership.add',
    'photo.trash',
    'photo.restore',
    'photo.original.mark',
  ] as const) {
    assert.equal(photoCommandAvailability(id, true).enabled, true, id);
  }
});
