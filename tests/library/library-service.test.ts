import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { run } from '../../src/main/db/sql.js';
import { LibraryService } from '../../src/main/library/library-service.js';
import { channels } from '../../src/shared/ipc/channels.js';
import { createInvoker, wrapHandler } from '../../src/shared/ipc/registry.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { serializeBoard, type Board } from '../../src/shared/moodboard/board.js';

// Contract tests (#71): the renderer-side invoker talks to the wrapped main
// handlers over a fake transport — both directions schema-validated — against
// a seeded temp library shaped like the design mock's data.

function seededService(): {
  service: LibraryService;
  db: ReturnType<typeof openLibraryDatabase>;
  events: { changed: string[][]; changedAlbums: (string[] | undefined)[]; originalChanged: string[][]; pending: number[] };
} {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-lib-')), 'library.db'),
    dbKey: randomBytes(32),
  });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'w', ?)`, '2026-07-01T00:00:00Z');
  const repo = new PhotosRepository(db);

  // Mock-shaped seed (ui_kits photos.js): every 5th is RAW, places rotate,
  // some favorites, one offloaded, one deleted.
  const cams = ['FUJIFILM X-T5', 'SONY A7 IV', 'APPLE iPHONE 15 PRO', 'RICOH GR III'];
  const places = ['Lisbon', 'Big Sur', 'Kyoto', 'Home'];
  const inserts: PhotoInsert[] = [];
  for (let i = 0; i < 20; i += 1) {
    const n = String(i).padStart(3, '0');
    inserts.push({
      id: `01J8LIB${n}`,
      fileName: `IMG_${String(4021 + i * 7)}${i % 5 === 0 ? '.RAF' : '.JPG'}`,
      fileKind: i % 5 === 0 ? 'raw' : 'jpeg',
      width: 6240,
      height: 4160,
      bytes: 8_400_000,
      contentHash: `hash-${n}`,
      camera: cams[i % 4] ?? null,
      lens: null,
      iso: 125,
      aperture: '1.8',
      shutter: '1/250',
      focalLength: 23,
      takenAt: `2026-06-${String((i % 27) + 1).padStart(2, '0')}T12:00:00.000Z`,
      gpsLat: null,
      gpsLon: null,
      place: places[i % 4] ?? null,
      importedAt: '2026-07-01T00:00:00.000Z',
      importSource: 'sd-card',
      favorite: i % 9 === 0,
      keyId: 1,
    });
  }
  for (const photo of inserts) {
    repo.insert(photo);
  }
  run(db, `UPDATE sync_ledger SET status = 'offloaded', dirty = 0 WHERE photo_id = '01J8LIB003'`);
  run(db, `UPDATE sync_ledger SET status = 'synced', dirty = 0 WHERE photo_id = '01J8LIB004'`);
  run(db, `UPDATE photos SET deleted_at = '2026-07-02T00:00:00Z' WHERE id = '01J8LIB005'`);

  const events = {
    changed: [] as string[][],
    changedAlbums: [] as (string[] | undefined)[],
    originalChanged: [] as string[][],
    pending: [] as number[],
  };
  const service = new LibraryService(db, {
    libraryChanged: (ids, _membership, albumIds) => {
      events.changed.push([...ids]);
      events.changedAlbums.push(albumIds === undefined ? undefined : [...albumIds]);
    },
    originalClassificationChanged: (ids) => events.originalChanged.push([...ids]),
    pendingCountChanged: (count) => events.pending.push(count),
  });
  return { service, db, events };
}

// A "renderer": invokers over a transport that calls the wrapped handlers,
// so malformed traffic in either direction rejects exactly as over IPC.
function rendererClient(service: LibraryService): {
  page: ReturnType<typeof createInvoker<typeof channels.libraryPage.request, typeof channels.libraryPage.response>>;
  selectAll: ReturnType<typeof createInvoker<typeof channels.librarySelectAll.request, typeof channels.librarySelectAll.response>>;
  selectionRange: ReturnType<
    typeof createInvoker<typeof channels.librarySelectionRange.request, typeof channels.librarySelectionRange.response>
  >;
  toggleFavorite: ReturnType<
    typeof createInvoker<typeof channels.libraryToggleFavorite.request, typeof channels.libraryToggleFavorite.response>
  >;
  toggleFavorites: ReturnType<
    typeof createInvoker<typeof channels.libraryToggleFavorites.request, typeof channels.libraryToggleFavorites.response>
  >;
  repairDimensions: ReturnType<
    typeof createInvoker<typeof channels.libraryRepairDimensions.request, typeof channels.libraryRepairDimensions.response>
  >;
  stats: ReturnType<typeof createInvoker<typeof channels.libraryStats.request, typeof channels.libraryStats.response>>;
} {
  const handlers: Record<string, (request: unknown) => Promise<unknown>> = {
    [channels.libraryPage.name]: wrapHandler(channels.libraryPage, (req) => service.page(req)),
    [channels.librarySelectAll.name]: wrapHandler(channels.librarySelectAll, (req) => ({ photoIds: service.selectAllIds(req) })),
    [channels.librarySelectionRange.name]: wrapHandler(channels.librarySelectionRange, (req) => service.selectionRange(req)),
    [channels.libraryToggleFavorite.name]: wrapHandler(channels.libraryToggleFavorite, ({ id }) => service.toggleFavorite(id)),
    [channels.libraryToggleFavorites.name]: wrapHandler(channels.libraryToggleFavorites, ({ photoIds }) =>
      service.toggleFavorites(photoIds),
    ),
    [channels.libraryRepairDimensions.name]: wrapHandler(channels.libraryRepairDimensions, ({ id, width, height }) =>
      service.repairDimensions(id, width, height),
    ),
    [channels.libraryStats.name]: wrapHandler(channels.libraryStats, () => service.stats()),
  };
  const transport = (name: string, request: unknown): Promise<unknown> => {
    const handler = handlers[name];
    if (handler === undefined) {
      return Promise.reject(new Error(`no handler for ${name}`));
    }
    return handler(request);
  };
  return {
    page: createInvoker(channels.libraryPage, transport),
    selectAll: createInvoker(channels.librarySelectAll, transport),
    selectionRange: createInvoker(channels.librarySelectionRange, transport),
    toggleFavorite: createInvoker(channels.libraryToggleFavorite, transport),
    toggleFavorites: createInvoker(channels.libraryToggleFavorites, transport),
    repairDimensions: createInvoker(channels.libraryRepairDimensions, transport),
    stats: createInvoker(channels.libraryStats, transport),
  };
}

describe('library IPC contract', () => {
  test('pages through the seeded library like the mock visible derivation', async () => {
    const { service } = seededService();
    const client = rendererClient(service);

    // All: 19 live photos (one deleted), newest taken_at first.
    const all = await client.page({ source: 'all', limit: 50 });
    assert.equal(all.photos.length, 19);

    // Chips AND-combine: raw + favorites.
    const rawFavorites = await client.page({
      source: 'all',
      limit: 50,
      chips: { raw: true, favorites: true },
    });
    for (const photo of rawFavorites.photos) {
      assert.equal(photo.fileKind, 'raw');
      assert.equal(photo.favorite, true);
    }
    // raw ∩ favorites in the seed: only i=0 (raw at 0,5,10,15; favorite at 0,9,18).
    assert.equal(rawFavorites.photos.length, 1);

    // Search: case-insensitive substring across name/place/camera.
    const kyoto = await client.page({ source: 'all', limit: 50, query: 'kyo' });
    assert.ok(kyoto.photos.length > 0);
    for (const photo of kyoto.photos) {
      assert.equal(photo.place, 'Kyoto');
    }
    const ricoh = await client.page({ source: 'all', limit: 50, query: 'ricoh' });
    assert.ok(ricoh.photos.every((photo) => photo.camera === 'RICOH GR III'));

    // Offloaded chip.
    const offloaded = await client.page({ source: 'all', limit: 50, chips: { offloaded: true } });
    assert.deepEqual(
      offloaded.photos.map((photo) => photo.id),
      ['01J8LIB003'],
    );

    // Local-only excludes offloaded/synced.
    const local = await client.page({ source: 'all', limit: 50, chips: { localOnly: true } });
    assert.equal(local.photos.length, 17);
  });

  test('malformed requests and responses reject at the boundary', async () => {
    const { service } = seededService();
    const client = rendererClient(service);
    // limit over the schema cap never reaches the service.
    await assert.rejects(client.page({ source: 'all', limit: 5000 }));
    // Unknown source enum rejects.
    await assert.rejects(client.page({ source: 'everything' as never, limit: 10 }));
  });

  test('Select All resolves complete library, album, filter, search, and combined scopes', async () => {
    const { service, db } = seededService();
    const client = rendererClient(service);

    const all = await client.selectAll({ source: 'all' });
    assert.equal(all.photoIds.length, 19);
    assert.equal(new Set(all.photoIds).size, all.photoIds.length);

    run(db, `INSERT INTO albums (id, name, created_at, position) VALUES ('AL1', 'Travel', '2026-07-01T00:00:00Z', 0)`);
    run(db, `INSERT INTO album_photos (album_id, photo_id, position) VALUES ('AL1', '01J8LIB000', 0)`);
    run(db, `INSERT INTO album_photos (album_id, photo_id, position) VALUES ('AL1', '01J8LIB001', 1)`);
    const album = await client.selectAll({ source: 'all', albumId: 'AL1' });
    assert.deepEqual(album.photoIds, ['01J8LIB001', '01J8LIB000']);

    const raw = await client.selectAll({ source: 'all', chips: { raw: true } });
    assert.equal(raw.photoIds.length, 3);
    const kyoto = await client.selectAll({ source: 'all', query: 'kyo' });
    assert.ok(kyoto.photoIds.length > 0);
    const combined = await client.selectAll({ source: 'all', albumId: 'AL1', chips: { raw: true }, query: 'IMG_' });
    assert.deepEqual(combined.photoIds, ['01J8LIB000']);
  });

  test('resolves complete active-projection ranges, including album and search scopes', async () => {
    const { service } = seededService();
    const client = rendererClient(service);
    const all = await client.page({ source: 'all', limit: 50 });
    const allRange = await client.selectionRange({
      source: 'all',
      anchorId: all.photos.at(-1)?.id ?? '',
      targetId: all.photos[0]?.id ?? '',
    });
    assert.deepEqual(
      allRange.photoIds,
      all.photos.map(({ id }) => id),
    );

    const searched = await client.page({ source: 'all', limit: 50, query: 'lisbon' });
    const searchRange = await client.selectionRange({
      source: 'all',
      query: 'lisbon',
      anchorId: searched.photos[0]?.id ?? '',
      targetId: searched.photos.at(-1)?.id ?? '',
    });
    assert.deepEqual(
      searchRange.photoIds,
      searched.photos.map(({ id }) => id),
    );

    service.createAlbum('ALB-RANGE', 'Range album');
    service.addToAlbum('ALB-RANGE', [all.photos[0]?.id ?? '', all.photos[1]?.id ?? '']);
    const albumRange = await client.selectionRange({
      source: 'all',
      albumId: 'ALB-RANGE',
      anchorId: all.photos[1]?.id ?? '',
      targetId: all.photos[0]?.id ?? '',
    });
    assert.deepEqual(albumRange.photoIds, [all.photos[0]?.id, all.photos[1]?.id]);
    const outside = await client.selectionRange({
      source: 'all',
      albumId: 'ALB-RANGE',
      anchorId: all.photos[0]?.id ?? '',
      targetId: '01J8LIB005',
    });
    assert.deepEqual(outside.photoIds, []);
  });

  test('favorite toggle bumps pendingCount and emits both events', async () => {
    const { service, events } = seededService();
    const client = rendererClient(service);
    const before = service.pendingCount(); // 18 dirty from seeding (2 cleared)

    const result = await client.toggleFavorite({ id: '01J8LIB004' });
    assert.equal(result.favorite, true);
    assert.equal(result.pendingCount, before + 1);
    assert.deepEqual(events.changed.at(-1), ['01J8LIB004']);
    assert.equal(events.pending.at(-1), before + 1);
  });

  test('bulk favorite toggle updates unloaded ids through one validated request', async () => {
    const { service, events } = seededService();
    const client = rendererClient(service);
    const before = service.pendingCount();

    const result = await client.toggleFavorites({ photoIds: ['01J8LIB004', '01J8LIB006', 'missing', '01J8LIB004'] });
    assert.deepEqual(result, { updated: 2, missing: 1, pendingCount: before + 1 });
    assert.equal(service.get('01J8LIB004')?.favorite, true);
    assert.equal(service.get('01J8LIB006')?.favorite, true);
    assert.deepEqual(events.changed.at(-1), ['01J8LIB004', '01J8LIB006']);
    assert.equal(events.pending.at(-1), before + 1);
  });

  test('Original classification is durable and emits targeted duplicate-policy invalidation', () => {
    const { service, events } = seededService();
    const before = service.pendingCount();

    assert.deepEqual(service.setOriginal(['01J8LIB004'], true), {
      changed: 1,
      unchanged: 0,
      missing: 0,
      pendingCount: before + 1,
      changedPhotoIds: ['01J8LIB004'],
    });
    assert.equal(service.get('01J8LIB004')?.isOriginal, true);
    assert.deepEqual(events.originalChanged, [['01J8LIB004']]);
    assert.deepEqual(service.deletePhotos(['01J8LIB004']), {
      deleted: 0,
      protected: 1,
      missing: 0,
      changedPhotoIds: [],
    });
  });

  test('legacy dimensions repair once through validated IPC and emits a targeted refresh (#367)', async () => {
    const { service, db, events } = seededService();
    const client = rendererClient(service);
    run(db, `UPDATE photos SET width = 0, height = 0 WHERE id = '01J8LIB004'`);
    const before = service.pendingCount();

    assert.deepEqual(await client.repairDimensions({ id: '01J8LIB004', width: 1919, height: 1279 }), {
      repaired: true,
      pendingCount: before + 1,
    });
    assert.deepEqual({ width: service.get('01J8LIB004')?.width, height: service.get('01J8LIB004')?.height }, { width: 1919, height: 1279 });
    assert.deepEqual(events.changed.at(-1), ['01J8LIB004']);
    assert.equal(events.pending.at(-1), before + 1);

    assert.deepEqual(await client.repairDimensions({ id: '01J8LIB004', width: 1, height: 1 }), {
      repaired: false,
      pendingCount: before + 1,
    });
    await assert.rejects(client.repairDimensions({ id: '01J8LIB004', width: 0, height: 1279 }));
  });

  test('albums lists names with live membership counts (#80)', () => {
    const { service, db } = seededService();
    run(db, `INSERT INTO albums (id, name, created_at, position) VALUES ('AL1', 'Travel', '2026-07-01T00:00:00Z', 0)`);
    run(db, `INSERT INTO album_photos (album_id, photo_id, position) VALUES ('AL1', '01J8LIB000', 0)`);
    run(db, `INSERT INTO album_photos (album_id, photo_id, position) VALUES ('AL1', '01J8LIB001', 1)`);
    run(db, `INSERT INTO albums (id, name, created_at, position) VALUES ('AL2', 'Empty', '2026-07-01T00:00:00Z', 1)`);
    assert.deepEqual(service.albums(), [
      { id: 'AL1', name: 'Travel', count: 2 },
      { id: 'AL2', name: 'Empty', count: 0 },
    ]);
  });

  test('album move publishes one targeted change and pending-count update (#279)', () => {
    const { service, events } = seededService();
    service.createAlbum('AL1', 'Source');
    service.createAlbum('AL2', 'Target');
    service.addToAlbum('AL1', ['01J8LIB003', '01J8LIB004']);
    events.changed.length = 0;
    events.changedAlbums.length = 0;
    events.pending.length = 0;

    assert.deepEqual(service.moveBetweenAlbums('AL1', 'AL2', ['01J8LIB003', '01J8LIB004']), {
      moved: 2,
      alreadyInTarget: 0,
    });
    assert.deepEqual(events.changed, [['01J8LIB003', '01J8LIB004']]);
    assert.deepEqual(events.changedAlbums, [['AL1', 'AL2']]);
    assert.equal(events.pending.length, 1);
    assert.equal(service.albums().find((album) => album.id === 'AL1')?.count, 0);
    assert.equal(service.albums().find((album) => album.id === 'AL2')?.count, 2);
  });

  test('gallery policy writes are library data and announce a library-wide membership change (#512)', () => {
    const { service, events } = seededService();
    assert.deepEqual(service.galleryPolicy(), { showUnavailable: true, minimumMegapixels: null });
    const before = events.changed.length;
    const stored = service.setGalleryPolicy({ showUnavailable: false, minimumMegapixels: 2 });
    assert.deepEqual(stored, { showUnavailable: false, minimumMegapixels: 2 });
    assert.deepEqual(service.galleryPolicy(), stored);
    assert.equal(events.changed.length, before + 1, 'one library:changed so open galleries and counts re-evaluate');
    assert.deepEqual(events.changed[before], []);
    assert.throws(() => service.setGalleryPolicy({ showUnavailable: true, minimumMegapixels: 0 }), 'hostile values never reach SQL');
  });

  test('stats reports live photo count, bytes, and pending for the chrome', async () => {
    const { service } = seededService();
    const client = rendererClient(service);
    const stats = await client.stats({});
    assert.equal(stats.photos, 19);
    assert.equal(stats.bytes, 19 * 8_400_000);
    // Fresh inserts mark the ledger dirty; two rows were settled by the
    // seed (offloaded + synced) and the deleted row leaves pendingCount
    // (#120 — it neither uploads nor shows in ENCRYPTING N), so 17 of 20.
    assert.equal(stats.pending, 17);
  });
});

describe('LibraryService boards (#694)', () => {
  const board = (id: string): Board => ({
    id,
    title: 'Board ' + id,
    notes: '',
    size: { width: 1600, height: 1200 },
    background: 'ink',
    placements: [
      { id: 'p1', photoId: 'ph1', x: 10, y: 20, w: 200, h: 150, rotation: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, z: 1, groupId: null },
    ],
  });

  test('saves, reads, lists, and deletes boards without touching photo events', () => {
    const { service, events } = seededService();
    assert.deepEqual(service.listBoards(), []);
    service.saveBoard(board('a'));
    service.saveBoard(board('b'));
    assert.deepEqual(
      service.listBoards().map((b) => b.id),
      ['a', 'b'],
    );
    assert.equal(serializeBoard(service.getBoard('a') as Board), serializeBoard(board('a')));
    assert.equal(service.getBoard('missing'), null);
    service.deleteBoard('a');
    assert.deepEqual(
      service.listBoards().map((b) => b.id),
      ['b'],
    );
    // Board edits are not photo mutations — they never fire libraryChanged.
    assert.deepEqual(events.changed, []);
  });
});
