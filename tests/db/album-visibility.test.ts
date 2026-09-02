import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { readHiddenAlbumIds, verifyInAllPhotos } from '../../src/main/db/album-visibility-repository.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { queryAll, run } from '../../src/main/db/sql.js';
import type { PageCursor, PhotoInsert, SourceFilter } from '../../src/shared/library/types.js';

// #494 / ADR-0030 §2 + §6: every album carries `show_in_all_photos`; a photo
// leaves All Photos only when every album containing it is hidden (inclusion
// wins); the composition flag is written with the change and rebuilt from the
// rows when it disagrees; exclusion touches nothing but the All Photos view.

const RECENT_SINCE = '2026-07-01T00:00:00.000Z';

let seq = 0;
function photo(overrides: Partial<PhotoInsert> = {}): PhotoInsert {
  seq += 1;
  const n = String(seq).padStart(6, '0');
  return {
    id: `01J8VIS${n}`,
    fileName: `IMG_${n}.JPG`,
    fileKind: 'jpeg',
    width: 4000,
    height: 3000,
    bytes: 1000 + seq,
    contentHash: `vis-hash-${n}`,
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
    ...overrides,
  };
}

interface WorldIds {
  /** In no album at all. */
  readonly loose: string;
  /** Only in `hikes`. */
  readonly hikeOnly: string;
  /** In `hikes` and `family`. */
  readonly shared: string;
  /** Only in `family`. */
  readonly familyOnly: string;
}

function world(): { repo: PhotosRepository; db: ReturnType<typeof openLibraryDatabase>; ids: WorldIds } {
  const db = openLibraryDatabase({ path: join(mkdtempSync(join(tmpdir(), 'overlook-visibility-')), 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-01-01T00:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  const loose = photo();
  const hikeOnly = photo();
  const shared = photo();
  const familyOnly = photo();
  for (const row of [loose, hikeOnly, shared, familyOnly]) repo.insert(row);
  repo.createAlbum('hikes', 'Hikes');
  repo.createAlbum('family', 'Family');
  repo.addToAlbum('hikes', [hikeOnly.id, shared.id]);
  repo.addToAlbum('family', [shared.id, familyOnly.id]);
  return { repo, db, ids: { loose: loose.id, hikeOnly: hikeOnly.id, shared: shared.id, familyOnly: familyOnly.id } };
}

function walk(repo: PhotosRepository, source: SourceFilter, albumId?: string, query?: string): string[] {
  const ids: string[] = [];
  let cursor: PageCursor | undefined;
  do {
    const page = repo.page({ source, recentSince: RECENT_SINCE, limit: 2, cursor, albumId, query });
    ids.push(...page.photos.map((item) => item.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return ids.sort();
}

function flags(db: ReturnType<typeof openLibraryDatabase>): Record<string, number> {
  return Object.fromEntries(
    queryAll<{ id: string; flag: number }>(db, 'SELECT id, in_all_photos AS flag FROM photos').map((row) => [row.id, row.flag]),
  );
}

describe('collection visibility in All Photos (#494)', () => {
  test('every album and every photo starts visible; the listing carries the policy', () => {
    const { repo, db, ids } = world();
    assert.deepEqual(readHiddenAlbumIds(db), []);
    assert.deepEqual(
      repo.albums().map((album) => [album.id, album.showInAllPhotos, album.count, album.visibleElsewhere]),
      [
        ['hikes', true, 2, 1],
        ['family', true, 2, 1],
      ],
    );
    assert.deepEqual(walk(repo, 'all'), [ids.loose, ids.hikeOnly, ids.shared, ids.familyOnly].sort());
    assert.equal(repo.counts(RECENT_SINCE).hiddenByAlbums, 0);
    db.close();
  });

  test('hiding an album removes only the photos no visible album still contains (inclusion wins)', () => {
    const { repo, db, ids } = world();
    const changed = repo.setAlbumVisibility('hikes', false);
    assert.deepEqual(changed, [ids.hikeOnly], 'the shared photo stays because Family is visible');
    assert.deepEqual(walk(repo, 'all'), [ids.loose, ids.shared, ids.familyOnly].sort());
    const counts = repo.counts(RECENT_SINCE);
    assert.equal(counts.all, 3);
    assert.equal(counts.hiddenByAlbums, 1);
    assert.equal(counts.excluded, 0, 'album hiding is not an inclusion rule');
    const hikes = repo.albums().find((album) => album.id === 'hikes');
    assert.equal(hikes?.showInAllPhotos, false);
    assert.equal(hikes?.visibleElsewhere, 1, 'the §2 disclosure: one photo stays via Family');
    assert.deepEqual(hikes?.visibleVia, [{ id: 'family', name: 'Family' }]);
    // Unanimous exclusion is the only thing that clears the flag.
    repo.setAlbumVisibility('family', false);
    assert.deepEqual(walk(repo, 'all'), [ids.loose]);
    assert.equal(repo.counts(RECENT_SINCE).hiddenByAlbums, 3);
    repo.setAlbumVisibility('family', true);
    assert.deepEqual(walk(repo, 'all'), [ids.loose, ids.shared, ids.familyOnly].sort());
    db.close();
  });

  test('exclusion is presentation only: the album view, explicit search, other sources, and select-all keep every row', () => {
    const { repo, db, ids } = world();
    repo.setAlbumVisibility('hikes', false);
    assert.deepEqual(walk(repo, 'all', 'hikes'), [ids.hikeOnly, ids.shared].sort());
    assert.deepEqual(walk(repo, 'all', undefined, 'IMG'), [ids.loose, ids.hikeOnly, ids.shared, ids.familyOnly].sort());
    repo.toggleFavorite(ids.hikeOnly);
    assert.deepEqual(walk(repo, 'favorites'), [ids.hikeOnly]);
    assert.ok([...repo.selectAllIds({ source: 'all', recentSince: RECENT_SINCE, albumId: 'hikes' })].includes(ids.hikeOnly));
    assert.equal(repo.albums().find((album) => album.id === 'hikes')?.count, 2, 'counts inside the collection are untouched');
    db.close();
  });

  test('membership changes maintain the flag in the same transaction', () => {
    const { repo, db, ids } = world();
    repo.setAlbumVisibility('hikes', false);
    // Joining a hidden album from nowhere hides; leaving it restores.
    repo.addToAlbum('hikes', [ids.loose]);
    assert.ok(!walk(repo, 'all').includes(ids.loose));
    repo.removeFromAlbum('hikes', [ids.loose]);
    assert.ok(walk(repo, 'all').includes(ids.loose));
    // Moving a photo from a visible album into the hidden one hides it.
    repo.moveBetweenAlbums('family', 'hikes', [ids.familyOnly]);
    assert.ok(!walk(repo, 'all').includes(ids.familyOnly));
    // Deleting the hidden album releases its members (photos are never deleted).
    repo.deleteAlbum('hikes');
    assert.deepEqual(walk(repo, 'all'), [ids.loose, ids.hikeOnly, ids.shared, ids.familyOnly].sort());
    assert.equal(repo.counts(RECENT_SINCE).hiddenByAlbums, 0);
    db.close();
  });

  test('the flag is never authoritative: a tampered flag is detected and rebuilt from the rows', () => {
    const { repo, db, ids } = world();
    repo.setAlbumVisibility('hikes', false);
    const expected = flags(db);
    run(db, 'UPDATE photos SET in_all_photos = 0 WHERE id = ?', ids.loose);
    run(db, 'UPDATE photos SET in_all_photos = 1 WHERE id = ?', ids.hikeOnly);
    assert.deepEqual(verifyInAllPhotos(db), { mismatched: 2, rebuilt: true });
    assert.deepEqual(flags(db), expected);
    assert.deepEqual(verifyInAllPhotos(db), { mismatched: 0, rebuilt: false });
    db.close();
  });

  test('hidden album ids are library data for the manifest, in sidebar order', () => {
    const { repo, db } = world();
    repo.setAlbumVisibility('family', false);
    repo.setAlbumVisibility('hikes', false);
    assert.deepEqual(repo.hiddenAlbumIds(), ['hikes', 'family']);
    assert.throws(() => repo.setAlbumVisibility('missing', false), /does not exist/u);
    db.close();
  });
});
