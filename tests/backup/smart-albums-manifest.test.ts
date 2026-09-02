import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  buildBackupManifestV9,
  buildBackupManifestV10,
  parseBackupManifest,
  type BackupManifestSnapshotV10,
} from '../../src/main/backup/backup-manifest.js';
import { albumVisibilityMatches, restoreAlbumVisibility } from '../../src/main/backup/restore-album-visibility.js';
import { albumTreeSnapshot } from '../../src/main/db/album-tree-repository.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { readSmartAlbums } from '../../src/main/db/smart-album-queries.js';
import { queryAll, run } from '../../src/main/db/sql.js';

// #514 / ADR-0030 §3 + §5: a Smart Album's predicate document is library
// data, carried by the manifest exactly as written (schema 10). Restore
// validates the placement like any collection, writes the document
// unchanged, and a document this version cannot evaluate survives the round
// trip marked unsupported instead of being rejected or rewritten.

const LIBRARY = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const AT = '2026-09-01T00:00:00.000Z';
const CREATED = '2026-07-01T00:00:00.000Z';
const album = (id: string, position: number) => ({ id, name: id, createdAt: CREATED, position, photoIds: [] });

type SmartV10 = BackupManifestSnapshotV10['smartAlbums'][number];
const TRIPS: BackupManifestSnapshotV10['folders'][number] = {
  id: 'trips',
  name: 'Trips',
  createdAt: CREATED,
  position: 0,
  parentId: null,
  showInAllPhotos: true,
  tags: [],
};
const FUJI: SmartV10 = {
  id: 'fuji',
  name: 'Fuji',
  createdAt: CREATED,
  position: 1,
  parentId: 'trips',
  predicate: { version: 1, composition: 'and', groups: [{ facet: 'camera', values: ['FUJIFILM X-T5'] }] },
  tags: ['gear'],
};
const FUTURE: SmartV10 = {
  id: 'future',
  name: 'Future',
  createdAt: CREATED,
  position: 3,
  parentId: null,
  predicate: { version: 99, composition: 'and', groups: [{ facet: 'hologram', values: ['x'] }] },
  tags: [],
};

const snapshot: BackupManifestSnapshotV10 = {
  databaseSchema: 30,
  keyIds: [],
  totals: { photos: 0, bytes: 0, albums: 1 },
  photos: [],
  albums: [album('hikes', 2)],
  protectedAlbums: [],
  protectedPhotos: [],
  activity: [],
  boards: [],
  sidecars: [],
  galleryPolicy: { showUnavailable: true, minimumMegapixels: null },
  hiddenAlbumIds: [],
  folders: [TRIPS],
  albumTree: [{ albumId: 'hikes', parentId: 'trips', inheritsVisibility: true, tags: [] }],
  smartAlbums: [FUJI, FUTURE],
};

const build = (patch: Partial<BackupManifestSnapshotV10>) =>
  buildBackupManifestV10({ libraryId: LIBRARY, generatedAt: AT, snapshot: { ...snapshot, ...patch } });

describe('smart albums in backup manifests (#514)', () => {
  test('schema 10 carries every predicate document as written and round-trips through the parser', () => {
    assert.equal(BACKUP_MANIFEST_SCHEMA_VERSION, 11);
    const manifest = build({});
    assert.equal(manifest.schema, 10);
    const parsed = parseBackupManifest(JSON.parse(JSON.stringify(manifest)));
    assert.ok(parsed.restorable);
    assert.ok('smartAlbums' in parsed.manifest);
    assert.deepEqual(parsed.manifest.smartAlbums, [FUJI, FUTURE], 'a version-99 document is carried, not rejected');
  });

  test('a Smart Album is placed like any collection: unique id, folder parent, one position per sibling', () => {
    assert.throws(() => build({ smartAlbums: [{ ...FUJI, id: 'hikes' }] }), /collides with a collection/u);
    assert.throws(() => build({ smartAlbums: [{ ...FUJI, parentId: 'hikes' }] }), /smartAlbums/u, 'an album cannot be a parent');
    assert.throws(() => build({ smartAlbums: [{ ...FUJI, position: 2 }] }), /shares position/u);
    assert.throws(() => build({ smartAlbums: [{ ...FUJI, predicate: { composition: 'and' } }] }), /integer version/u);
  });

  test('schema 9 manifests still parse and restore with no Smart Albums', () => {
    const { smartAlbums: _smart, ...v9Snapshot } = snapshot;
    const v9 = buildBackupManifestV9({ libraryId: LIBRARY, generatedAt: AT, snapshot: { ...v9Snapshot, databaseSchema: 29 } });
    assert.equal(v9.schema, 9);
    const parsed = parseBackupManifest(v9);
    assert.ok(parsed.restorable);
    assert.ok(!('smartAlbums' in parsed.manifest));
    assert.throws(() => parseBackupManifest({ ...v9, schema: 10 }), /invalid schema-10 manifest/u);
  });

  test('restore writes the documents unchanged, tags and placement included, and verifies the tree', () => {
    const db = openLibraryDatabase({
      path: join(mkdtempSync(join(tmpdir(), 'overlook-smart-restore-')), 'library.db'),
      dbKey: randomBytes(32),
    });
    run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-01-01T00:00:00.000Z')`);
    for (const row of snapshot.albums) {
      run(db, `INSERT INTO albums (id, name, created_at, position) VALUES (?, ?, ?, ?)`, row.id, row.name, row.createdAt, row.position);
    }
    const manifest = build({});
    restoreAlbumVisibility(db, manifest);
    const tree = albumTreeSnapshot(db);
    assert.deepEqual(
      [...tree.smartAlbums].sort((left, right) => left.id.localeCompare(right.id)),
      [FUJI, FUTURE].sort((left, right) => left.id.localeCompare(right.id)),
    );
    assert.equal(albumVisibilityMatches(db, manifest), true);
    const stored = readSmartAlbums(db);
    assert.deepEqual(stored.get('fuji')?.predicate, FUJI.predicate);
    assert.equal(stored.get('fuji')?.unsupported, null);
    assert.equal(stored.get('future')?.predicate, null);
    assert.match(stored.get('future')?.unsupported ?? '', /newer than this app/u);
    assert.equal(
      queryAll<{ p: string }>(db, `SELECT predicate AS p FROM albums WHERE id = 'future'`)[0]?.p,
      JSON.stringify(FUTURE.predicate),
      'the unsupported document is stored exactly as carried',
    );
    run(db, `UPDATE albums SET parent_id = NULL WHERE id = 'fuji'`);
    assert.equal(albumVisibilityMatches(db, manifest), false, 'a Smart Album that drifted fails the verification');
    db.close();
  });
});
