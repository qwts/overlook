import { test } from 'node:test';
import assert from 'node:assert/strict';

import { libraryRowActions, libraryRowState } from '../../src/renderer/src/shell/library-row-actions.js';
import type { LibraryDescriptor } from '../../src/shared/library/registry.js';

// #1299 (Pass D spec, Actions menu): the switcher row's enablement table for
// all four row states. Every action is listed; a blocked one carries why.

const CURRENT = '01ARZ3NDEKTSV4RRFFQ69G5FAA';

function library(overrides: Partial<LibraryDescriptor> = {}): LibraryDescriptor {
  return {
    id: '01BRZ3NDEKTSV4RRFFQ69G5FAB',
    name: 'Beta',
    path: '/Users/ansel/Pictures/Overlook/Beta',
    createdAt: '2026-07-01T00:00:00.000Z',
    lastOpenedAt: null,
    missing: false,
    open: false,
    lockedBy: null,
    ...overrides,
  };
}

test('the open library can do everything but leave the list', () => {
  const open = library({ id: CURRENT, open: true });
  assert.equal(libraryRowState(open, CURRENT), 'open');
  assert.deepEqual(libraryRowActions(open, CURRENT), {
    displayName: null,
    rename: null,
    move: null,
    remove: { reason: 'open' },
  });
});

test('the current library counts as open even before the list marks it', () => {
  assert.equal(libraryRowState(library({ id: CURRENT }), CURRENT), 'open');
});

test('an available library allows every action', () => {
  const available = library();
  assert.equal(libraryRowState(available, CURRENT), 'available');
  assert.deepEqual(libraryRowActions(available, CURRENT), { displayName: null, rename: null, move: null, remove: null });
});

test('a missing library can be renamed for display or removed, not renamed on disk or moved', () => {
  const missing = library({ missing: true });
  assert.equal(libraryRowState(missing, CURRENT), 'missing');
  assert.deepEqual(libraryRowActions(missing, CURRENT), {
    displayName: null,
    rename: { reason: 'missing' },
    move: { reason: 'missing' },
    remove: null,
  });
});

test('a library open elsewhere names the host that has to close it', () => {
  const elsewhere = library({ lockedBy: 'CLARAS-MACBOOK' });
  assert.equal(libraryRowState(elsewhere, CURRENT), 'elsewhere');
  assert.deepEqual(libraryRowActions(elsewhere, CURRENT), {
    displayName: null,
    rename: { reason: 'elsewhere', host: 'CLARAS-MACBOOK' },
    move: { reason: 'elsewhere', host: 'CLARAS-MACBOOK' },
    remove: null,
  });
});

test('a missing volume explains itself before a stale lock does', () => {
  assert.equal(libraryRowState(library({ missing: true, lockedBy: 'CLARAS-MACBOOK' }), CURRENT), 'missing');
});
