import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createCollection, deleteFolder, readAlbumTags, setAlbumTags } from '../../src/main/db/album-tree-repository.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { compilePredicate } from '../../src/main/db/predicate-compiler.js';
import { facetValues, readSmartAlbums, smartAlbumCount } from '../../src/main/db/smart-album-queries.js';
import { createSmartAlbum, duplicateSmartAlbum, setSmartAlbumPredicate } from '../../src/main/db/smart-album-repository.js';
import { queryAll, run } from '../../src/main/db/sql.js';
import {
  EMPTY_PREDICATE,
  parseSmartPredicate,
  predicateEquals,
  toggleFacetValue,
  type FacetGroup,
  type SmartPredicate,
} from '../../src/shared/library/smart-album.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #514 / ADR-0030 §3, §4, §6: one compiler turns a predicate document into
// SQL for both the live facet filter and a saved Smart Album; values inside a
// facet are a union and facets compose by an explicit AND / OR; unknown
// dimensions never match a size range; the count and the page come from the
// same compiled predicate; and creating, editing, duplicating, or deleting a
// Smart Album never touches a photo. Unknown documents fail closed.

const CAMERAS = ['FUJIFILM X-T5', 'SONY A7 IV', 'APPLE iPHONE 15 PRO', 'RICOH GR III'] as const;
const LENSES = ['XF 23mm', 'FE 35mm'] as const;
const PLACES = ['Lisbon', 'Kyoto', null] as const;
const SIZES = [
  [6000, 4000],
  [4000, 3000],
  [1000, 1000],
  [3000, 2000],
] as const;

interface Row {
  readonly id: string;
  readonly fileKind: string;
  readonly camera: string;
  readonly lens: string;
  readonly place: string | null;
  readonly width: number;
  readonly height: number;
  readonly favorite: boolean;
  readonly userTags: readonly string[];
  readonly importedKeywords: readonly string[];
  readonly suppressed: readonly string[];
  readonly status: string;
  readonly unavailable: boolean;
  readonly unknownSize: boolean;
}

function insert(index: number): PhotoInsert {
  const n = String(index).padStart(3, '0');
  const size = SIZES[index % SIZES.length] ?? SIZES[0];
  return {
    id: `01J8SMART${n}`,
    fileName: `IMG_${n}.${index % 3 === 0 ? 'RAF' : 'JPG'}`,
    fileKind: index % 3 === 0 ? 'raw' : 'jpeg',
    width: size[0],
    height: size[1],
    bytes: 1000 + index,
    contentHash: `smart-hash-${n}`,
    camera: CAMERAS[index % CAMERAS.length] ?? null,
    lens: LENSES[index % LENSES.length] ?? null,
    iso: null,
    aperture: null,
    shutter: null,
    focalLength: null,
    takenAt: `2026-06-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`,
    gpsLat: null,
    gpsLon: null,
    place: PLACES[index % PLACES.length] ?? null,
    importedAt: `2026-06-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`,
    importSource: 'test',
    keyId: 1,
  };
}

interface World {
  readonly db: ReturnType<typeof openLibraryDatabase>;
  readonly repo: PhotosRepository;
  readonly rows: readonly Row[];
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'overlook-smart-albums-'));
  const db = openLibraryDatabase({ path: join(dir, 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped', '2026-01-01T00:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  const rows: Row[] = [];
  for (let index = 0; index < 12; index += 1) {
    const photo = insert(index);
    repo.insert(photo);
    const favorite = index % 5 === 0;
    if (favorite) repo.toggleFavorite(photo.id);
    const userTags = index === 1 || index === 2 ? ['Trip'] : [];
    const importedKeywords = index === 2 || index === 3 ? ['trip', 'beach'] : [];
    const suppressed = index === 3 ? ['trip'] : [];
    run(
      db,
      'UPDATE photos SET user_tags = ?, imported_keywords = ?, suppressed_keywords = ? WHERE id = ?',
      JSON.stringify(userTags),
      JSON.stringify(importedKeywords),
      JSON.stringify(suppressed),
      photo.id,
    );
    const status = index === 4 || index === 5 ? 'offloaded' : 'local';
    if (status !== 'local') run(db, 'UPDATE sync_ledger SET status = ? WHERE photo_id = ?', status, photo.id);
    const unknownSize = index === 11;
    if (unknownSize) run(db, `UPDATE photos SET dimension_status = 'unavailable' WHERE id = ?`, photo.id);
    const failed = index === 6;
    if (failed) run(db, `UPDATE photos SET preview_failure = 'decode-failed' WHERE id = ?`, photo.id);
    rows.push({
      id: photo.id,
      fileKind: photo.fileKind,
      camera: photo.camera ?? '',
      lens: photo.lens ?? '',
      place: photo.place,
      width: photo.width,
      height: photo.height,
      favorite,
      userTags,
      importedKeywords,
      suppressed,
      status,
      unavailable: failed || unknownSize,
      unknownSize,
    });
  }
  return { db, repo, rows };
}

/** The row-by-row truth the compiler must reproduce. */
function matches(row: Row, group: FacetGroup): boolean {
  switch (group.facet) {
    case 'fileType':
      return group.values.includes(row.fileKind);
    case 'camera':
      return group.values.includes(row.camera);
    case 'lens':
      return group.values.includes(row.lens);
    case 'location':
      return row.place !== null && group.values.includes(row.place);
    case 'tag': {
      const suppressed = new Set(row.suppressed.map((tag) => tag.toLowerCase()));
      const effective = new Set([
        ...row.userTags.map((tag) => tag.toLowerCase()),
        ...row.importedKeywords.map((tag) => tag.toLowerCase()).filter((tag) => !suppressed.has(tag)),
      ]);
      return group.values.some((value) => effective.has(value.toLowerCase()));
    }
    case 'favorite':
      return group.values.includes(row.favorite ? 'yes' : 'no');
    case 'custody':
      return group.values.includes(row.status);
    case 'availability':
      return group.values.includes(row.unavailable ? 'unavailable' : 'available');
    case 'megapixels': {
      if (row.unknownSize) return false;
      const pixels = row.width * row.height;
      return group.ranges.some(
        (range) => (range.min === null || pixels >= range.min * 1_000_000) && (range.max === null || pixels <= range.max * 1_000_000),
      );
    }
  }
}

function expected(rows: readonly Row[], predicate: SmartPredicate): string[] {
  return rows
    .filter((row) => {
      if (predicate.groups.length === 0) return true;
      const results = predicate.groups.map((group) => matches(row, group));
      return predicate.composition === 'and' ? results.every(Boolean) : results.some(Boolean);
    })
    .map((row) => row.id)
    .sort();
}

function predicate(composition: 'and' | 'or', ...groups: FacetGroup[]): SmartPredicate {
  return { version: 1, composition, groups };
}

function assertAgrees(world: World, doc: SmartPredicate, label: string): string[] {
  const want = expected(world.rows, doc);
  const page = world.repo
    .page({ source: 'all', limit: 100, predicate: doc })
    .photos.map((photo) => photo.id)
    .sort();
  assert.deepEqual(page, want, `${label}: page`);
  assert.equal(smartAlbumCount(world.db, doc), want.length, `${label}: count`);
  return want;
}

describe('smart albums (#514)', () => {
  test('migration 030 adds a JSON-checked predicate column', () => {
    const { db } = world();
    const columns = queryAll<{ name: string }>(db, 'PRAGMA table_info(albums)').map((row) => row.name);
    assert.ok(columns.includes('predicate'));
    assert.throws(() =>
      run(db, `INSERT INTO albums (id, name, created_at, position, kind, predicate) VALUES ('x', 'x', 'now', 0, 'smart', '{not json')`),
    );
  });

  test('every facet compiles to the row-by-row truth, for the count and the page alike', () => {
    const w = world();
    const cases: readonly [string, FacetGroup][] = [
      ['fileType', { facet: 'fileType', values: ['raw'] }],
      ['camera', { facet: 'camera', values: ['SONY A7 IV'] }],
      ['lens', { facet: 'lens', values: ['XF 23mm'] }],
      ['location', { facet: 'location', values: ['Kyoto'] }],
      ['tag (case-insensitive, suppression honored)', { facet: 'tag', values: ['TRIP'] }],
      ['tag (imported keyword)', { facet: 'tag', values: ['beach'] }],
      ['favorite yes', { facet: 'favorite', values: ['yes'] }],
      ['favorite no', { facet: 'favorite', values: ['no'] }],
      ['custody', { facet: 'custody', values: ['offloaded'] }],
      ['availability unavailable', { facet: 'availability', values: ['unavailable'] }],
      ['availability available', { facet: 'availability', values: ['available'] }],
      ['megapixels open-ended', { facet: 'megapixels', ranges: [{ min: 12, max: null }] }],
      ['megapixels bounded', { facet: 'megapixels', ranges: [{ min: 0, max: 6 }] }],
    ];
    for (const [label, group] of cases) {
      const ids = assertAgrees(w, predicate('and', group), label);
      assert.ok(ids.length > 0 && ids.length < w.rows.length, `${label} is a discriminating fixture (${String(ids.length)})`);
    }
    assert.deepEqual(assertAgrees(w, EMPTY_PREDICATE, 'empty'), w.rows.map((row) => row.id).sort());
    // The suppressed keyword: photo 3 carries "trip" only as an imported keyword it suppressed.
    assert.ok(!expected(w.rows, predicate('and', { facet: 'tag', values: ['trip'] })).includes('01J8SMART003'));
  });

  test('values within a facet are a union; facets compose by an explicit AND or OR', () => {
    const w = world();
    const cameras: FacetGroup = { facet: 'camera', values: ['FUJIFILM X-T5', 'SONY A7 IV'] };
    const raw: FacetGroup = { facet: 'fileType', values: ['raw'] };
    const union = assertAgrees(w, predicate('and', cameras), 'union');
    assert.equal(union.length, 6);
    const both = assertAgrees(w, predicate('and', cameras, raw), 'and');
    const either = assertAgrees(w, predicate('or', cameras, raw), 'or');
    assert.ok(both.length < union.length && union.length < either.length);
    assert.equal(either.length, new Set([...union, ...expected(w.rows, predicate('and', raw))]).size);
    // The compiler names its parameters per group so two groups never collide.
    const compiled = compilePredicate(predicate('or', cameras, raw));
    assert.match(compiled.where, /\) OR \(/u);
    assert.deepEqual(Object.keys(compiled.params).sort(), ['f0v0', 'f0v1', 'f1v0']);
  });

  test('unknown dimensions never match a size range, even one starting at zero', () => {
    const w = world();
    const ids = assertAgrees(w, predicate('and', { facet: 'megapixels', ranges: [{ min: 0, max: null }] }), 'min 0');
    assert.equal(ids.length, w.rows.length - 1);
    assert.ok(!ids.includes('01J8SMART011'));
  });

  test('facet values enumerate what the library holds, with counts, merging tags case-insensitively', () => {
    const w = world();
    const cameras = facetValues(w.db, 'camera');
    assert.deepEqual(
      cameras.map((entry) => [entry.value, entry.count]),
      [...CAMERAS].map((camera) => [camera, 3]).sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en', { sensitivity: 'base' })),
    );
    assert.deepEqual(
      facetValues(w.db, 'location').map((entry) => entry.value),
      ['Kyoto', 'Lisbon'],
    );
    const tags = facetValues(w.db, 'tag');
    assert.deepEqual(
      tags.map((entry) => [entry.value.toLowerCase(), entry.count]),
      [
        ['trip', 2],
        ['beach', 2],
      ].sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0]))),
    );
  });

  test('create, edit, duplicate, rename, and delete never touch a photo or a membership row', () => {
    const w = world();
    createCollection(w.db, { id: 'trips', name: 'Trips', kind: 'folder', parentId: null });
    const doc = predicate('and', { facet: 'camera', values: ['FUJIFILM X-T5'] });
    createSmartAlbum(w.db, { id: 'fuji', name: 'Fuji', parentId: 'trips', predicate: doc });
    setAlbumTags(w.db, 'fuji', ['gear'], () => 'tag-1');
    const before = queryAll<{ n: number }>(w.db, 'SELECT count(*) AS n FROM photos')[0]?.n;
    const listing = () => w.repo.albums().find((album) => album.id === 'fuji');
    assert.equal(listing()?.kind, 'smart');
    assert.equal(listing()?.count, 3);
    assert.equal(listing()?.parentId, 'trips');
    assert.ok(predicateEquals(listing()?.predicate ?? EMPTY_PREDICATE, doc));
    assert.equal(listing()?.unsupported, null);
    // A folder's count is its albums' distinct photos — a Smart Album adds nothing.
    assert.equal(w.repo.albums().find((album) => album.id === 'trips')?.count, 0);

    const widened = toggleFacetValue(doc, 'camera', 'SONY A7 IV', true);
    setSmartAlbumPredicate(w.db, 'fuji', widened);
    assert.equal(listing()?.count, 6);
    duplicateSmartAlbum(w.db, 'fuji', 'fuji-copy', 'Fuji copy', () => 'tag-2');
    const copy = w.repo.albums().find((album) => album.id === 'fuji-copy');
    assert.equal(copy?.parentId, 'trips');
    assert.equal(copy?.count, 6);
    assert.deepEqual(readAlbumTags(w.db).get('fuji-copy'), ['gear']);
    assert.equal(
      queryAll<{ p: string }>(w.db, `SELECT predicate AS p FROM albums WHERE id = 'fuji'`)[0]?.p,
      queryAll<{ p: string }>(w.db, `SELECT predicate AS p FROM albums WHERE id = 'fuji-copy'`)[0]?.p,
      'the copy carries the document byte for byte',
    );
    w.repo.renameAlbum('fuji-copy', 'Renamed');
    assert.equal(w.repo.albums().find((album) => album.id === 'fuji-copy')?.name, 'Renamed');
    assert.deepEqual(w.repo.deleteAlbum('fuji-copy'), [], 'no members to re-manifest');
    // A Smart Album never takes members.
    assert.throws(() => w.repo.addToAlbum('fuji', ['01J8SMART000']));
    assert.equal(queryAll<{ n: number }>(w.db, 'SELECT count(*) AS n FROM album_photos')[0]?.n, 0);
    assert.equal(queryAll<{ n: number }>(w.db, 'SELECT count(*) AS n FROM photos')[0]?.n, before);
    // Deleting the folder recursively counts the Smart Album apart from albums.
    const removed = deleteFolder(w.db, 'trips', { mode: 'recursive' });
    assert.equal(removed.smart, 1);
    assert.equal(removed.albums, 0);
    assert.equal(queryAll<{ n: number }>(w.db, 'SELECT count(*) AS n FROM photos')[0]?.n, before);
  });

  test('a document this app cannot evaluate is preserved unchanged and reported, never dropped', () => {
    const w = world();
    createCollection(w.db, { id: 'future', name: 'Future', kind: 'smart', parentId: null });
    const raw = '{"version":99,"composition":"and","groups":[{"facet":"hologram","values":["x"]}]}';
    run(w.db, 'UPDATE albums SET predicate = ? WHERE id = ?', raw, 'future');
    const stored = readSmartAlbums(w.db).get('future');
    assert.equal(stored?.predicate, null);
    assert.match(stored?.unsupported ?? '', /newer than this app/u);
    const listing = w.repo.albums().find((album) => album.id === 'future');
    assert.equal(listing?.count, 0);
    assert.equal(listing?.predicate, null);
    assert.equal(listing?.unsupported, stored?.unsupported);
    assert.equal(queryAll<{ p: string }>(w.db, `SELECT predicate AS p FROM albums WHERE id = 'future'`)[0]?.p, raw);
    // An unknown facet at the current version fails closed too.
    assert.match(
      parseSmartPredicate({ version: 1, composition: 'and', groups: [{ facet: 'hologram', values: ['x'] }] }).ok ? '' : 'closed',
      /closed/u,
    );
    const unknownFacet = parseSmartPredicate({ version: 1, composition: 'and', groups: [{ facet: 'hologram', values: ['x'] }] });
    assert.ok(!unknownFacet.ok && /hologram/u.test(unknownFacet.reason));
  });
});
