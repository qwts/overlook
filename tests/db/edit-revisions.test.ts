import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import type Database from 'better-sqlite3-multiple-ciphers';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { EditRevisionRepository } from '../../src/main/db/edit-revision-repository.js';
import { MIGRATIONS } from '../../src/main/db/migrations.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { queryAll, queryGet, run } from '../../src/main/db/sql.js';
import type { EditOperation, EditRevisionDocument } from '../../src/shared/library/edit-revision.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #493 / ADR-0031 §2 + §8: edit revisions are immutable rows chained by
// parent id; the photo's head pointer is the only mutable state and moves in
// the same transaction as the append. Deleting a photo takes its history
// with it, and a restored library carries the chain and the head unchanged.

function photo(id: string): PhotoInsert {
  return {
    id,
    fileName: `${id}.JPG`,
    fileKind: 'jpeg',
    width: 30,
    height: 20,
    bytes: 42,
    contentHash: (id === 'P1' ? 'a' : 'b').repeat(64),
    camera: 'Camera',
    lens: null,
    iso: 100,
    aperture: '2.8',
    shutter: '1/125',
    focalLength: 35,
    takenAt: '2026-07-14T20:00:00.000Z',
    gpsLat: null,
    gpsLon: null,
    place: null,
    importedAt: '2026-07-14T21:00:00.000Z',
    importSource: 'camera',
    keyId: 1,
  };
}

function open(): { db: Database.Database; photos: PhotosRepository; revisions: EditRevisionRepository } {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-edit-revisions-')), 'library.db'),
    dbKey: Buffer.alloc(32, 9),
  });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-14T20:00:00.000Z')`);
  const photos = new PhotosRepository(db);
  photos.insert(photo('P1'));
  photos.insert(photo('P2'));
  return { db, photos, revisions: new EditRevisionRepository(db) };
}

let seq = 0;
function document(parentId: string | null, operations: readonly EditOperation[]): EditRevisionDocument {
  seq += 1;
  return {
    version: 1,
    id: `01J8ED${String(seq).padStart(20, '0')}`,
    parentId,
    operations,
    author: { product: 'overlook', version: '0.0.0-test' },
    createdAt: `2026-09-01T10:00:${String(seq).padStart(2, '0')}.000Z`,
    importedFrom: null,
  };
}

const ROTATE: EditOperation = { type: 'rotate', version: 1, quarterTurns: 1 };
const CROP: EditOperation = { type: 'crop', version: 1, left: 0, top: 0, width: 0.5, height: 0.5 };

describe('edit revisions (#493)', () => {
  test('migration 31 adds the revision table, its index, and the head pointer', () => {
    const { db } = open();
    assert.ok(MIGRATIONS.some((migration) => migration.version === 31 && migration.name === 'edit-revisions'));
    assert.ok(queryGet(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'edit_revisions'`) !== undefined);
    assert.ok(queryGet(db, `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'edit_revisions_photo'`) !== undefined);
    assert.ok(queryAll<{ name: string }>(db, `PRAGMA table_info(photos)`).some((column) => column.name === 'edit_head'));
    db.close();
  });

  test('append chains revisions, moves the head atomically, and lists newest first', () => {
    const { db, revisions } = open();
    assert.deepEqual(revisions.head('P1'), { photoId: 'P1', head: null, history: [] });
    const first = revisions.append('P1', document(null, [ROTATE]));
    const second = revisions.append('P1', document(first.id, [ROTATE, CROP]));
    const head = revisions.head('P1');
    assert.equal(head.head?.id, second.id);
    assert.equal(head.head?.parentId, first.id);
    assert.deepEqual(head.head?.transform, { quarterTurns: 1, flipped: false, crop: { left: 0, top: 0, width: 0.5, height: 0.5 } });
    assert.deepEqual(
      head.history.map((revision) => [revision.id, revision.current]),
      [
        [second.id, true],
        [first.id, false],
      ],
    );
    assert.equal(revisions.head('P2').head, null, 'another photo is untouched');
    assert.equal(revisions.get(first.id)?.photoId, 'P1');
    assert.throws(() => revisions.append('missing', document(null, [])), /not found/u);
    db.close();
  });

  test('a revision this build cannot evaluate is kept and reported unsupported', () => {
    const { db, revisions } = open();
    const foreign = { type: 'curve', version: 7, points: [] } as unknown as EditOperation;
    revisions.append('P1', document(null, [ROTATE, foreign]));
    const head = revisions.head('P1');
    assert.notEqual(head.head?.unsupported, null);
    assert.deepEqual(head.head?.transform, { quarterTurns: 0, flipped: false, crop: null }, 'unsupported stacks fold to identity');
    db.close();
  });

  test('deleting a photo cascades its history and the empty root is the NULL head', () => {
    const { db, revisions } = open();
    const first = revisions.append('P1', document(null, [ROTATE]));
    revisions.append('P1', document(first.id, []));
    assert.equal(revisions.list('P1').length, 2);
    run(db, `DELETE FROM photos WHERE id = ?`, 'P1');
    assert.equal(queryAll(db, `SELECT id FROM edit_revisions`).length, 0);
    db.close();
  });

  test('snapshot and restore carry the chain and the head across libraries', () => {
    const source = open();
    const first = source.revisions.append('P1', document(null, [ROTATE]));
    const second = source.revisions.append('P1', document(first.id, [CROP]));
    source.revisions.append('P2', document(null, [ROTATE]));
    const carried = source.revisions.snapshot(new Set(['P1', 'P2']));
    assert.equal(carried.length, 3);
    assert.deepEqual(
      carried.filter((revision) => revision.current).map((revision) => revision.id),
      [second.id, carried[2]?.id],
    );

    const target = open();
    // Children before parents: restore orders the writes itself.
    target.revisions.restore([...carried].reverse());
    assert.deepEqual(target.revisions.head('P1'), source.revisions.head('P1'));
    assert.deepEqual(target.revisions.head('P2'), source.revisions.head('P2'));
    assert.deepEqual(target.revisions.snapshot(new Set(['P1', 'P2'])), carried);
    source.db.close();
    target.db.close();
  });
});
