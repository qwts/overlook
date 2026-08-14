import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LedgerTransitionError, SyncLedger, assertTransition } from '../../src/main/backup/sync-ledger.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { run } from '../../src/main/db/sql.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #104: the dirtiness bookkeeping the whole backup UX rides on — validated
// machine, ONE dirty choke-point, stamps on verified completion.

function world() {
  const db = openLibraryDatabase({ path: join(mkdtempSync(join(tmpdir(), 'overlook-ledger-')), 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT OR IGNORE INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-13T00:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  const insert = (id: string): void => {
    repo.insert({
      id,
      fileName: `${id}.JPG`,
      fileKind: 'jpeg',
      width: 1,
      height: 1,
      bytes: 10,
      contentHash: id.repeat(8).slice(0, 64).padEnd(64, '0'),
      camera: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focalLength: null,
      takenAt: null,
      gpsLat: null,
      gpsLon: null,
      place: null,
      importedAt: '2026-07-13T00:00:00.000Z',
      importSource: 'test',
      keyId: 1,
    } satisfies PhotoInsert);
  };
  return { db, repo, ledger: new SyncLedger(db), insert };
}

describe('sync ledger machine (#104)', () => {
  test('the transition table: every legal edge passes, every other edge throws', () => {
    const legal: [string, string][] = [
      ['local', 'syncing'],
      ['syncing', 'synced'],
      ['syncing', 'error'],
      ['syncing', 'local'],
      ['synced', 'syncing'],
      ['synced', 'offloaded'],
      ['offloaded', 'synced'],
      ['error', 'syncing'],
    ];
    const states = ['local', 'syncing', 'synced', 'offloaded', 'error'] as const;
    for (const from of states) {
      for (const to of states) {
        const isLegal = legal.some(([f, t]) => f === from && t === to);
        if (isLegal) {
          assertTransition(from, to);
        } else {
          assert.throws(() => {
            assertTransition(from, to);
          }, LedgerTransitionError);
        }
      }
    }
  });

  test('migration v2: the error status is storable; a fresh row starts local+dirty', () => {
    const { ledger, insert } = world();
    insert('A');
    assert.equal(ledger.status('A'), 'local');
    assert.equal(ledger.pendingCount(), 1);
    // error reachable via the machine (local → syncing → error).
    ledger.setStatus('A', 'syncing');
    ledger.markError('A');
    assert.equal(ledger.status('A'), 'error');
  });

  test('EXIT CRITERIA: edits dirty through the choke-point without call sites changing', () => {
    const { repo, ledger, insert } = world();
    insert('A');
    ledger.setStatus('A', 'syncing');
    ledger.markBackedUp('A', '2026-07-13T01:00:00.000Z');
    assert.equal(ledger.pendingCount(), 0);
    // The favorite flow (E4.7) dirties via markDirty — unchanged call site.
    repo.toggleFavorite('A');
    assert.equal(ledger.pendingCount(), 1);
  });

  test('verified completion clears dirty and stamps lastBackupAt; errors stay dirty', () => {
    const { repo, ledger, insert } = world();
    insert('A');
    insert('B');
    assert.equal(ledger.lastBackupAt(), null, 'null before the first backup');
    ledger.setStatus('A', 'syncing');
    ledger.markBackedUp('A', '2026-07-13T02:00:00.000Z');
    assert.equal(ledger.pendingCount(), 1, 'only B remains dirty');
    assert.equal(ledger.lastBackupAt(), '2026-07-13T02:00:00.000Z');
    assert.equal(repo.stats().lastBackupAt, '2026-07-13T02:00:00.000Z');

    ledger.setStatus('B', 'syncing');
    ledger.markError('B');
    assert.equal(ledger.pendingCount(), 1, 'an errored row STAYS dirty (will retry)');
  });

  test('integrity healing reports only the error to offloaded transition', () => {
    const { ledger, insert } = world();
    insert('A');
    ledger.repairStatus('A', 'error');
    assert.equal(ledger.healIntegrityError('A'), true);
    assert.equal(ledger.status('A'), 'offloaded');
    assert.equal(ledger.healIntegrityError('A'), false, 'an already-healed row emits no duplicate update');
  });

  test('setStatus on a missing row throws — a bug, not a state', () => {
    const { ledger } = world();
    assert.throws(() => {
      ledger.setStatus('GHOST', 'syncing');
    }, LedgerTransitionError);
  });
});
