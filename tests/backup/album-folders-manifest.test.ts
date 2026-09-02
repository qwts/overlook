import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  buildBackupManifestV8,
  buildBackupManifestV9,
  parseBackupManifest,
  type BackupManifestSnapshotV9,
} from '../../src/main/backup/backup-manifest.js';
import { albumVisibilityMatches, restoreAlbumVisibility } from '../../src/main/backup/restore-album-visibility.js';
import { albumTreeSnapshot } from '../../src/main/db/album-tree-repository.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { queryAll, run } from '../../src/main/db/sql.js';

// #505 / ADR-0030 §5 + §7: folders, placements, folder policies, and tags are
// library data in the manifest (schema 9). Restore validates the tree before
// any row is written and rebuilds inherited policies and the per-photo flag
// from the restored rows instead of trusting them.

const LIBRARY = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const AT = '2026-09-01T00:00:00.000Z';
const album = (id: string, position: number) => ({ id, name: id, createdAt: '2026-07-01T00:00:00.000Z', position, photoIds: [] });

type FolderV9 = BackupManifestSnapshotV9['folders'][number];
type PlacementV9 = BackupManifestSnapshotV9['albumTree'][number];
const TRIPS: FolderV9 = {
  id: 'trips',
  name: 'Trips',
  createdAt: '2026-07-01T00:00:00.000Z',
  position: 0,
  parentId: null,
  showInAllPhotos: false,
  tags: ['travel'],
};
const HIKES: PlacementV9 = { albumId: 'hikes', parentId: 'trips', inheritsVisibility: true, tags: ['outdoors'] };
const FAMILY: PlacementV9 = { albumId: 'family', parentId: null, inheritsVisibility: false, tags: [] };

const snapshot: BackupManifestSnapshotV9 = {
  databaseSchema: 29,
  keyIds: [],
  totals: { photos: 0, bytes: 0, albums: 2 },
  photos: [],
  albums: [album('hikes', 1), album('family', 2)],
  protectedAlbums: [],
  protectedPhotos: [],
  activity: [],
  boards: [],
  sidecars: [],
  galleryPolicy: { showUnavailable: true, minimumMegapixels: null },
  hiddenAlbumIds: ['hikes'],
  folders: [TRIPS],
  albumTree: [HIKES, FAMILY],
};

const build = (patch: Partial<BackupManifestSnapshotV9>) =>
  buildBackupManifestV9({ libraryId: LIBRARY, generatedAt: AT, snapshot: { ...snapshot, ...patch } });

describe('album folders in backup manifests (#505)', () => {
  test('schema 9 carries folders, placements, and tags, and round-trips through the parser', () => {
    assert.equal(BACKUP_MANIFEST_SCHEMA_VERSION, 12);
    const manifest = build({});
    assert.equal(manifest.schema, 9);
    const parsed = parseBackupManifest(JSON.parse(JSON.stringify(manifest)) as unknown);
    assert.equal(parsed.restorable, true);
    if (parsed.restorable && parsed.manifest.schema === 9) {
      assert.deepEqual(
        parsed.manifest.folders.map((folder) => folder.id),
        ['trips'],
      );
      assert.deepEqual(
        parsed.manifest.albumTree.map((placement) => placement.parentId),
        ['trips', null],
      );
    }
  });

  test('restore validates the tree before writing anything', () => {
    const placement = (patch: Partial<PlacementV9>): PlacementV9[] => [{ ...HIKES, ...patch }, FAMILY];
    assert.throws(() => build({ albumTree: [FAMILY] }), /every album needs a placement/u);
    assert.throws(() => build({ albumTree: [HIKES, FAMILY, { ...FAMILY }] }), /album placed twice/u);
    assert.throws(() => build({ albumTree: placement({ albumId: 'ghost' }) }), /placement names no album/u);
    assert.throws(() => build({ albumTree: placement({ parentId: 'family' }) }), /not a folder/u);
    assert.throws(() => build({ albumTree: placement({ parentId: 'nowhere' }) }), /does not exist/u);
    assert.throws(() => build({ albumTree: placement({ parentId: null, inheritsVisibility: true }) }), /no folder to inherit/u);
    assert.throws(() => build({ folders: [{ ...TRIPS, id: 'hikes' }] }), /collides with an album/u);
    const folder = TRIPS;
    assert.throws(
      () =>
        build({
          folders: [
            { ...folder, parentId: 'loop' },
            { ...folder, id: 'loop', position: 3, parentId: 'trips' },
          ],
        }),
      /cycle/u,
    );
    assert.throws(() => build({ folders: [{ ...folder, position: 2 }] }), /shares position/u, 'positions are unique among siblings');
    const chain: FolderV9[] = Array.from({ length: 8 }, (_, depth) => ({
      ...folder,
      id: depth === 0 ? 'trips' : `d${String(depth)}`,
      position: depth === 0 ? 0 : 10 + depth,
      parentId: depth === 0 ? null : depth === 1 ? 'trips' : `d${String(depth - 1)}`,
    }));
    assert.throws(() => build({ folders: chain }), /nests deeper than 6 levels/u);
    // Schema 8 still parses; a schema-9 header without the tree does not.
    const { folders: _folders, albumTree: _albumTree, ...v8Snapshot } = snapshot;
    const v8 = buildBackupManifestV8({ libraryId: LIBRARY, generatedAt: AT, snapshot: v8Snapshot });
    assert.equal(parseBackupManifest(v8).restorable, true);
    assert.throws(() => parseBackupManifest({ ...v8, schema: 9 }), /invalid schema-9 manifest/u);
  });

  test('restore writes the tree, settles inherited policy from the rows, and verifies it', () => {
    const open = () =>
      openLibraryDatabase({ path: join(mkdtempSync(join(tmpdir(), 'overlook-folders-restore-')), 'library.db'), dbKey: randomBytes(32) });
    const seed = (db: ReturnType<typeof open>): void => {
      run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-01-01T00:00:00.000Z')`);
      for (const row of snapshot.albums) {
        run(db, `INSERT INTO albums (id, name, created_at, position) VALUES (?, ?, ?, ?)`, row.id, row.name, row.createdAt, row.position);
      }
      run(
        db,
        `INSERT INTO photos (id, file_name, file_kind, width, height, bytes, content_hash, imported_at, import_source, key_id, in_all_photos)
         VALUES ('P1', 'a.jpg', 'jpeg', 10, 10, 1, 'h1', '2026-06-01T00:00:00.000Z', 'test', 1, 1)`,
      );
      run(db, `INSERT INTO sync_ledger (photo_id, status, dirty) VALUES ('P1', 'local', 1)`);
      run(db, `INSERT INTO album_photos (album_id, photo_id, position) VALUES ('hikes', 'P1', 0)`);
    };
    const db = open();
    seed(db);
    const manifest = build({});
    restoreAlbumVisibility(db, manifest);
    const tree = albumTreeSnapshot(db);
    assert.deepEqual(tree.folders, snapshot.folders);
    assert.deepEqual(tree.albumTree, snapshot.albumTree);
    assert.deepEqual(
      queryAll<{ id: string; show: number; inherits: number }>(
        db,
        'SELECT id, show_in_all_photos AS show, inherits_visibility AS inherits FROM albums ORDER BY position',
      ).map((row) => [row.id, row.show, row.inherits]),
      [
        ['trips', 0, 0],
        ['hikes', 0, 1],
        ['family', 1, 0],
      ],
    );
    assert.deepEqual(queryAll<{ flag: number }>(db, `SELECT in_all_photos AS flag FROM photos WHERE id = 'P1'`), [{ flag: 0 }]);
    assert.equal(albumVisibilityMatches(db, manifest), true);
    run(db, `UPDATE albums SET parent_id = NULL WHERE id = 'hikes'`);
    assert.equal(albumVisibilityMatches(db, manifest), false, 'a restored tree that drifted fails the verification');
    db.close();

    // A schema-8 manifest restores every album at the top level and matches that expectation.
    const legacy = open();
    seed(legacy);
    const { folders: _folders, albumTree: _albumTree, ...v8Snapshot } = snapshot;
    const v8 = buildBackupManifestV8({ libraryId: LIBRARY, generatedAt: AT, snapshot: v8Snapshot });
    restoreAlbumVisibility(legacy, v8);
    assert.deepEqual(albumTreeSnapshot(legacy).folders, []);
    assert.equal(albumVisibilityMatches(legacy, v8), true);
    legacy.close();
  });
});
