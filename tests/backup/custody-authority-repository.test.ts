import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { CustodyAuthorityRepository } from '../../src/main/backup/custody-authority-repository.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { run } from '../../src/main/db/sql.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

function world() {
  const db = openLibraryDatabase({ path: join(mkdtempSync(join(tmpdir(), 'overlook-custody-')), 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-25T00:00:00.000Z')`);
  const photos = new PhotosRepository(db);
  const insert = (id: string, bytes = 10): void => {
    photos.insert({
      id,
      fileName: `${id}.jpg`,
      fileKind: 'jpeg',
      width: 1,
      height: 1,
      bytes,
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
      importedAt: '2026-07-25T00:00:00.000Z',
      importSource: 'test',
      keyId: 1,
    } satisfies PhotoInsert);
  };
  return { db, insert, ledger: new SyncLedger(db), authorities: new CustodyAuthorityRepository(db) };
}

describe('custody authority provenance (#729)', () => {
  test('authority records are stable, queryable, and cannot bind a provider-required source', () => {
    const { db, insert, ledger, authorities } = world();
    insert('A');
    ledger.setStatus('A', 'syncing');
    ledger.markBackedUp('A', '2026-07-25T01:00:00.000Z');
    const input = {
      providerId: 'pcloud',
      accountId: '42',
      accountLabel: 'account@example.test',
      remoteRoot: '/Overlook/01ARZ3NDEKTSV4RRFFQ69G5FAA/',
      createdAt: '2026-07-25T01:00:01.000Z',
    };
    const authority = authorities.create(input);
    assert.deepEqual(authorities.get(authority.id), authority);
    assert.equal(authorities.get(999), undefined);
    assert.equal(authorities.find('pcloud', 'other', input.remoteRoot), undefined);
    assert.deepEqual(authorities.create(input), authority, 'the authority triple is stable across retries');

    run(db, `UPDATE custody_authorities SET state = 'provider-required' WHERE id = ?`, authority.id);
    assert.throws(() => ledger.markOffloaded('A', authority.id), /not bound/u);
  });

  test('an offload binds a named authority, errors retain it, and verified local recovery clears it', () => {
    const { db, insert, ledger, authorities } = world();
    insert('A', 42);
    ledger.setStatus('A', 'syncing');
    ledger.markBackedUp('A', '2026-07-25T01:00:00.000Z');
    const authority = authorities.create({
      providerId: 'pcloud',
      accountId: '42',
      accountLabel: 'account@example.test',
      remoteRoot: '/Overlook/01ARZ3NDEKTSV4RRFFQ69G5FAA/',
      createdAt: '2026-07-25T01:00:01.000Z',
    });

    ledger.markOffloaded('A', authority.id);
    assert.equal(ledger.status('A'), 'offloaded');
    assert.deepEqual(authorities.soleCustodyCounts(), [{ authority, items: 1, bytes: 42 }]);

    ledger.repairStatus('A', 'error');
    assert.deepEqual(authorities.soleCustodyCounts(), [{ authority, items: 1, bytes: 42 }], 'remote-loss truth keeps the source binding');

    run(db, `UPDATE sync_ledger SET status = 'offloaded' WHERE photo_id = 'A'`);
    ledger.setStatus('A', 'synced');
    assert.equal(authorities.soleCustodyCounts().length, 0, 'durable verified local bytes clear the binding atomically');
  });

  test('legacy unbound offloaded rows are counted separately and never assigned to a new authority', () => {
    const { insert, ledger, authorities } = world();
    insert('A', 17);
    ledger.setStatus('A', 'syncing');
    ledger.markBackedUp('A', '2026-07-25T01:00:00.000Z');
    ledger.setStatus('A', 'offloaded');

    assert.deepEqual(authorities.legacyUnboundCount(), { items: 1, bytes: 17 });
    assert.deepEqual(authorities.soleCustodyCounts(), []);
  });
});
