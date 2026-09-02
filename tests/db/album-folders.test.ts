import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  deleteFolder,
  moveCollection,
  readAlbumTags,
  readAlbumTree,
  setAlbumTags,
  setCollectionVisibility,
  albumTreeSnapshot,
} from '../../src/main/db/album-tree-repository.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { queryAll, run } from '../../src/main/db/sql.js';
import { MAX_ALBUM_DEPTH } from '../../src/shared/library/album-tree.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #505 / ADR-0030 §1, §2, §5: one collection table with `kind`, a parent that
// may only be a folder, positions among siblings, cycles and the depth bound
// rejected inside the write, folder visibility as an inheritable default,
// organizational tags in their own vocabulary, and a deletion ceremony that
// never touches photos.

const RECENT = '2026-07-01T00:00:00.000Z';
let seq = 0;
function photo(): PhotoInsert {
  seq += 1;
  const n = String(seq).padStart(6, '0');
  return {
    id: `01J8FOLD${n}`,
    fileName: `IMG_${n}.JPG`,
    fileKind: 'jpeg',
    width: 4000,
    height: 3000,
    bytes: 1000 + seq,
    contentHash: `fold-hash-${n}`,
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
    importedAt: '2026-06-01T00:00:00.000Z',
    importSource: 'test',
    keyId: 1,
  };
}

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'overlook-album-folders-'));
  const db = openLibraryDatabase({ path: join(dir, 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped', '2026-01-01T00:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  const order = (): string[] => readAlbumTree(db).map((row) => row.id);
  const listing = (id: string) => {
    const found = repo.albums().find((album) => album.id === id);
    assert.ok(found, `${id} is listed`);
    return found;
  };
  const inAllPhotos = (photoId: string): number =>
    queryAll<{ flag: number }>(db, `SELECT in_all_photos AS flag FROM photos WHERE id = '${photoId}'`)[0]?.flag ?? -1;
  return { db, repo, order, listing, inAllPhotos };
}

describe('album folders (#505)', () => {
  test('migration 029 adds the tree columns and the separate tag vocabulary', () => {
    const { db } = world();
    const columns = queryAll<{ name: string }>(db, 'PRAGMA table_info(albums)').map((row) => row.name);
    for (const column of ['kind', 'parent_id', 'inherits_visibility']) assert.ok(columns.includes(column), column);
    const tables = queryAll<{ name: string }>(db, `SELECT name FROM sqlite_master WHERE type = 'table'`).map((row) => row.name);
    assert.ok(tables.includes('album_tags') && tables.includes('album_tag_links'));
    // ADR-0030 §1: no shared identifier with photo keywords — the tag tables
    // reference albums only.
    const links = queryAll<{ name: string }>(db, 'PRAGMA table_info(album_tag_links)').map((row) => row.name);
    assert.deepEqual(links, ['album_id', 'tag_id']);
    db.close();
  });

  test('folders nest albums in depth-first order; a folder counts the distinct photos beneath it', () => {
    const { db, repo, order, listing } = world();
    repo.createAlbum('loose', 'Loose');
    const folder = repo.createAlbum('trips', 'Trips', { kind: 'folder' });
    assert.equal(folder.kind, 'folder');
    assert.equal(folder.parentId, null);
    const child = repo.createAlbum('iceland', 'Iceland', { parentId: 'trips' });
    assert.deepEqual([child.kind, child.parentId, child.inheritsVisibility, child.showInAllPhotos], ['album', 'trips', true, true]);
    repo.createAlbum('nested', 'Nested', { kind: 'folder', parentId: 'trips' });
    repo.createAlbum('japan', 'Japan', { parentId: 'nested' });
    repo.createAlbum('later', 'Later');
    assert.deepEqual(order(), ['loose', 'trips', 'iceland', 'nested', 'japan', 'later']);
    assert.deepEqual(
      repo.albums().map((album) => album.id),
      ['loose', 'trips', 'iceland', 'nested', 'japan', 'later'],
    );

    const shared = photo();
    const only = photo();
    repo.insert(shared);
    repo.insert(only);
    repo.addToAlbum('iceland', [shared.id, only.id]);
    repo.addToAlbum('japan', [shared.id]);
    assert.equal(listing('trips').count, 2, 'distinct photos across the subtree');
    assert.equal(listing('nested').count, 1);
    assert.equal(listing('iceland').count, 2);
    assert.throws(() => repo.addToAlbum('trips', [shared.id]), /does not exist/u, 'folders never hold photos');
    assert.equal(repo.albumForProtection('trips'), undefined, 'folders are not protection candidates');
    db.close();
  });

  test('rejects non-folder parents, cycles, and nesting past the depth bound inside the write', () => {
    const { db, repo, order } = world();
    repo.createAlbum('album', 'Album');
    assert.throws(() => repo.createAlbum('child', 'Child', { parentId: 'album' }), /is not a folder/u);
    assert.throws(() => repo.createAlbum('orphan', 'Orphan', { parentId: 'ghost' }), /does not exist/u);
    let parent: string | null = null;
    for (let depth = 0; depth <= MAX_ALBUM_DEPTH; depth += 1) {
      const id = `f${String(depth)}`;
      repo.createAlbum(id, id, { kind: 'folder', parentId: parent });
      parent = id;
    }
    assert.throws(() => repo.createAlbum('too-deep', 'Too deep', { parentId: parent }), /nest at most/u);
    assert.throws(() => moveCollection(db, 'f0', 'f3'), /into itself/u, 'a folder cannot move under its own descendant');
    assert.throws(() => moveCollection(db, 'f2', 'f2'), /into itself/u);
    assert.throws(() => moveCollection(db, 'f1', 'album'), /is not a folder/u);
    assert.throws(() => moveCollection(db, 'album', `f${String(MAX_ALBUM_DEPTH)}`), /nest at most/u);
    assert.deepEqual(order().slice(0, 2), ['album', 'f0'], 'a rejected move leaves the tree untouched');
    assert.deepEqual(readAlbumTree(db).find((row) => row.id === 'f3')?.parentId, 'f2');
    db.close();
  });

  test('reorder moves among siblings only and a folder carries its subtree', () => {
    const { db, repo, order } = world();
    repo.createAlbum('a', 'A');
    repo.createAlbum('trips', 'Trips', { kind: 'folder' });
    repo.createAlbum('x', 'X', { parentId: 'trips' });
    repo.createAlbum('y', 'Y', { parentId: 'trips' });
    repo.createAlbum('b', 'B');
    assert.deepEqual(order(), ['a', 'trips', 'x', 'y', 'b']);
    const moved = repo.reorderAlbum('y', 0);
    assert.deepEqual([moved.changed, moved.position, moved.total], [true, 0, 2]);
    assert.deepEqual(moved.after, ['a', 'trips', 'y', 'x', 'b']);
    assert.deepEqual(order(), ['a', 'trips', 'y', 'x', 'b']);
    const top = repo.reorderAlbum('trips', 0);
    assert.deepEqual([top.position, top.total], [0, 3]);
    assert.deepEqual(order(), ['trips', 'y', 'x', 'a', 'b']);
    assert.throws(() => repo.reorderAlbum('y', 2), /out of range/u, 'positions are sibling indexes');
    // Moving into a folder appends as its last child; back to the top level too.
    moveCollection(db, 'a', 'trips');
    assert.deepEqual(order(), ['trips', 'y', 'x', 'a', 'b']);
    moveCollection(db, 'y', null);
    assert.deepEqual(order(), ['trips', 'x', 'a', 'b', 'y']);
    db.close();
  });

  test('a folder policy is the default for descendants that have not set their own (§2)', () => {
    const { db, repo, listing, inAllPhotos } = world();
    repo.createAlbum('trips', 'Trips', { kind: 'folder' });
    repo.createAlbum('iceland', 'Iceland', { parentId: 'trips' });
    repo.createAlbum('own', 'Own');
    const p1 = photo();
    const p2 = photo();
    repo.insert(p1);
    repo.insert(p2);
    repo.addToAlbum('iceland', [p1.id]);
    repo.addToAlbum('own', [p2.id]);

    // Hiding the folder hides the inheriting child and its photo, transactionally.
    assert.deepEqual(setCollectionVisibility(db, 'trips', false).sort(), [p1.id]);
    assert.deepEqual(
      [listing('trips').showInAllPhotos, listing('iceland').showInAllPhotos, listing('iceland').inheritsVisibility],
      [false, false, true],
    );
    assert.equal(inAllPhotos(p1.id), 0);
    assert.equal(repo.counts(RECENT).hiddenByAlbums, 1);

    // An explicit setting on the child wins over the inherited one.
    assert.deepEqual(setCollectionVisibility(db, 'iceland', true), [p1.id]);
    assert.deepEqual([listing('iceland').showInAllPhotos, listing('iceland').inheritsVisibility], [true, false]);
    assert.equal(inAllPhotos(p1.id), 1);
    // ...and it can follow the folder again.
    assert.deepEqual(setCollectionVisibility(db, 'iceland', 'inherit'), [p1.id]);
    assert.deepEqual([listing('iceland').showInAllPhotos, listing('iceland').inheritsVisibility], [false, true]);
    assert.throws(() => setCollectionVisibility(db, 'own', 'inherit'), /no folder/u);

    // A visible album entering a folder adopts its policy; a hidden one keeps its own.
    assert.deepEqual(moveCollection(db, 'own', 'trips'), [p2.id]);
    assert.deepEqual([listing('own').showInAllPhotos, listing('own').inheritsVisibility], [false, true]);
    assert.equal(inAllPhotos(p2.id), 0);
    setCollectionVisibility(db, 'own', false);
    moveCollection(db, 'own', null);
    assert.deepEqual([listing('own').showInAllPhotos, listing('own').inheritsVisibility], [false, false]);
    setCollectionVisibility(db, 'trips', true);
    assert.equal(inAllPhotos(p1.id), 1, 'the inheriting child followed the folder back');
    assert.equal(inAllPhotos(p2.id), 0, 'the explicit one did not');

    // The manifest snapshot carries folder policy and album placement, never the per-photo flag.
    assert.deepEqual(
      albumTreeSnapshot(db).folders.map((f) => [f.id, f.parentId, f.showInAllPhotos]),
      [['trips', null, true]],
    );
    assert.deepEqual(
      albumTreeSnapshot(db).albumTree.map((a) => [a.albumId, a.parentId, a.inheritsVisibility]),
      [
        ['iceland', 'trips', true],
        ['own', null, false],
      ],
    );
    db.close();
  });

  test('deleting a folder hands its children on or removes the structure — never photos (Tier M)', () => {
    const { db, repo, order, inAllPhotos } = world();
    repo.createAlbum('trips', 'Trips', { kind: 'folder' });
    repo.createAlbum('europe', 'Europe', { kind: 'folder', parentId: 'trips' });
    repo.createAlbum('iceland', 'Iceland', { parentId: 'europe' });
    repo.createAlbum('asia', 'Asia', { parentId: 'trips' });
    repo.createAlbum('archive', 'Archive', { kind: 'folder' });
    const p = photo();
    repo.insert(p);
    repo.addToAlbum('iceland', [p.id]);
    setCollectionVisibility(db, 'trips', false);
    assert.equal(inAllPhotos(p.id), 0);

    assert.throws(() => deleteFolder(db, 'trips', { mode: 'move', destinationId: 'europe' }), /being deleted/u);
    assert.throws(() => deleteFolder(db, 'iceland', { mode: 'recursive' }), /does not exist/u, 'albums are not folders');
    const moved = deleteFolder(db, 'trips', { mode: 'move', destinationId: 'archive' });
    assert.deepEqual([moved.folders, moved.albums, moved.removedIds], [1, 0, ['trips']]);
    assert.deepEqual(order(), ['archive', 'europe', 'iceland', 'asia']);
    assert.deepEqual(
      readAlbumTree(db).map((row) => [row.id, row.parentId]),
      [
        ['archive', null],
        ['europe', 'archive'],
        ['iceland', 'europe'],
        ['asia', 'archive'],
      ],
    );
    assert.equal(inAllPhotos(p.id), 1, 'the children now follow a visible folder');

    const removed = deleteFolder(db, 'archive', { mode: 'recursive' });
    assert.deepEqual([removed.folders, removed.albums], [2, 2]);
    assert.deepEqual([...removed.removedIds].sort(), ['archive', 'asia', 'europe', 'iceland']);
    assert.deepEqual(removed.members, [p.id]);
    assert.deepEqual(order(), []);
    assert.equal(repo.get(p.id)?.id, p.id, 'photos survive');
    assert.equal(inAllPhotos(p.id), 1);
    assert.equal(queryAll(db, 'SELECT 1 FROM album_photos').length, 0);
    assert.equal(
      queryAll<{ dirty: number }>(db, `SELECT dirty FROM sync_ledger WHERE photo_id = '${p.id}'`)[0]?.dirty,
      1,
      'the former member re-manifests',
    );
    db.close();
  });

  test('organizational tags are their own vocabulary: case-insensitive, pruned when unused, never photo keywords', () => {
    const { db, repo, listing } = world();
    repo.createAlbum('trips', 'Trips', { kind: 'folder' });
    repo.createAlbum('iceland', 'Iceland', { parentId: 'trips' });
    let n = 0;
    const newId = (): string => `tag-${String((n += 1))}`;
    assert.deepEqual(setAlbumTags(db, 'trips', [' Travel', 'travel', 'Family ', ''], newId), ['Travel', 'Family']);
    assert.deepEqual(setAlbumTags(db, 'iceland', ['TRAVEL'], newId), ['TRAVEL']);
    assert.deepEqual(readAlbumTags(db).get('iceland'), ['Travel'], 'the first spelling is the vocabulary entry');
    assert.deepEqual(listing('trips').tags, ['Family', 'Travel']);
    assert.equal(queryAll(db, 'SELECT id FROM album_tags').length, 2);
    setAlbumTags(db, 'trips', [], newId);
    assert.deepEqual(readAlbumTags(db).get('trips'), undefined);
    assert.equal(queryAll(db, 'SELECT id FROM album_tags').length, 1, 'Family is pruned, Travel is still linked');
    assert.throws(() => setAlbumTags(db, 'ghost', ['x'], newId), /does not exist/u);
    const p = photo();
    repo.insert(p);
    assert.deepEqual(repo.get(p.id)?.userTags, [], 'photo keywords are untouched by album tags');
    assert.deepEqual(albumTreeSnapshot(db).albumTree[0]?.tags, ['Travel']);
    db.close();
  });
});
