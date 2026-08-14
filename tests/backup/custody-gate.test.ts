import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { SoleCustodyCount } from '../../src/main/backup/custody-authority-repository.js';
import { CustodyGate, CustodyHintCoordinator, custodyHintPreflight } from '../../src/main/backup/custody-gate.js';
import type { LibraryEntry } from '../../src/shared/library/registry.js';

const credential = { providerId: 'pcloud', accountId: '42' };

function count(accountId: string, items: number, bytes: number): SoleCustodyCount {
  return {
    authority: {
      id: Number(accountId),
      providerId: 'pcloud',
      accountId,
      accountLabel: `${accountId}@example.test`,
      remoteRoot: '/Overlook/01ARZ3NDEKTSV4RRFFQ69G5FAA/',
      state: 'bound',
      createdAt: '2026-08-06T00:00:00.000Z',
      lastVerifiedAt: null,
    },
    items,
    bytes,
  };
}

function library(id: string, name: string, custodyHints?: LibraryEntry['custodyHints']): LibraryEntry {
  return {
    id,
    name,
    path: `/libraries/${id}`,
    createdAt: '2026-08-06T00:00:00.000Z',
    lastOpenedAt: null,
    ...(custodyHints === undefined ? {} : { custodyHints }),
  };
}

describe('custody-gated provider changes (#732)', () => {
  test('unions matching active bindings, legacy rows, and sealed-library hints without counting another account', () => {
    const active = library('01ARZ3NDEKTSV4RRFFQ69G5FAA', 'Active');
    const sibling = library('01ARZ3NDEKTSV4RRFFQ69G5FAB', 'Archive', [
      { providerId: 'pcloud', accountId: '42', soleCustodyItems: 3, soleCustodyBytes: 300 },
      { providerId: 'pcloud', accountId: '99', soleCustodyItems: 9, soleCustodyBytes: 900 },
    ]);
    const gate = new CustodyGate({
      authorities: {
        soleCustodyCounts: () => [count('42', 2, 200), count('99', 7, 700)],
        legacyUnboundCount: () => ({ items: 1, bytes: 50 }),
      },
      activeLibrary: () => active,
      libraries: () => [active, sibling],
    });

    assert.deepEqual(gate.preflight(credential), {
      credential,
      totalItems: 6,
      totalBytes: 550,
      libraries: [
        { libraryId: active.id, name: 'Active', items: 3, bytes: 250, legacyUnbound: true },
        { libraryId: sibling.id, name: 'Archive', items: 3, bytes: 300, legacyUnbound: false },
      ],
    });
  });

  test('returns an empty exact result when no library depends on the credential', () => {
    const active = library('01ARZ3NDEKTSV4RRFFQ69G5FAA', 'Active');
    const gate = new CustodyGate({
      authorities: { soleCustodyCounts: () => [count('99', 1, 10)], legacyUnboundCount: () => ({ items: 0, bytes: 0 }) },
      activeLibrary: () => active,
      libraries: () => [active],
    });
    assert.deepEqual(gate.preflight(credential), { credential, totalItems: 0, totalBytes: 0, libraries: [] });
  });
});

describe('custody registry hint safety (#732)', () => {
  test('writes a conservative prospective hint before binding and clears it only from an exact recount', () => {
    let counts: readonly SoleCustodyCount[] = [count('42', 2, 200)];
    let legacy = { items: 1, bytes: 25 };
    const writes: LibraryEntry['custodyHints'][] = [];
    const coordinator = new CustodyHintCoordinator({
      authorities: { soleCustodyCounts: () => counts, legacyUnboundCount: () => legacy },
      write: (hints) => writes.push(hints),
    });

    coordinator.beforeBinding(credential, 75);
    assert.deepEqual(writes.at(-1), [
      { providerId: 'pcloud', accountId: '42', soleCustodyItems: 3, soleCustodyBytes: 275 },
      { legacyUnbound: true, soleCustodyItems: 1, soleCustodyBytes: 25 },
    ]);
    counts = [];
    coordinator.refresh();
    assert.deepEqual(writes.at(-1), [{ legacyUnbound: true, soleCustodyItems: 1, soleCustodyBytes: 25 }]);
    legacy = { items: 0, bytes: 0 };
    coordinator.refresh();
    assert.deepEqual(writes.at(-1), []);
  });

  test('sealed active libraries remain fail-closed from registry hints', () => {
    const sealed = library('sealed', 'Sealed', [{ providerId: 'pcloud', accountId: '42', soleCustodyItems: 3, soleCustodyBytes: 300 }]);
    assert.deepEqual(custodyHintPreflight(credential, [sealed]), {
      credential,
      totalItems: 3,
      totalBytes: 300,
      libraries: [{ libraryId: 'sealed', name: 'Sealed', items: 3, bytes: 300, legacyUnbound: false }],
    });
  });

  test('sealed legacy-unbound rows block removal of every credential', () => {
    const sealed = library('sealed', 'Sealed', [{ legacyUnbound: true, soleCustodyItems: 2, soleCustodyBytes: 50 }]);
    assert.deepEqual(custodyHintPreflight({ providerId: 'google-drive', accountId: 'any-account' }, [sealed]), {
      credential: { providerId: 'google-drive', accountId: 'any-account' },
      totalItems: 2,
      totalBytes: 50,
      libraries: [{ libraryId: 'sealed', name: 'Sealed', items: 2, bytes: 50, legacyUnbound: true }],
    });
  });

  test('pre-ADR sealed entries block until their database has produced a verified hint', () => {
    const unknown = library('unknown', 'Not opened since upgrade');
    assert.deepEqual(custodyHintPreflight(credential, [unknown]), {
      credential,
      totalItems: 0,
      totalBytes: 0,
      libraries: [],
      unverifiedLibraries: [{ libraryId: 'unknown', name: 'Not opened since upgrade' }],
    });
  });
});
