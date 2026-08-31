import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import type { EnvelopeKey } from '../../src/main/crypto/envelope.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { queryAll } from '../../src/main/db/sql.js';
import { EMBEDDING_DIMENSIONS, EmbeddingRepository } from '../../src/main/db/embedding-repository.js';
import { EMBEDDING_MODEL_MANIFEST } from '../../src/main/embedding/model-manifest.js';
import { sampleJpeg, SEED_ALBUMS, seedLibrary, seedSemanticIndex, seedSynthetic } from '../../src/main/library/seed.js';
import { SemanticSearch } from '../../src/main/library/semantic-search.js';

const KEY: EnvelopeKey = { id: 1, key: randomBytes(32) };

async function seeded(count: number): Promise<{
  db: ReturnType<typeof openLibraryDatabase>;
  repo: PhotosRepository;
  store: BlobStore;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-seed-'));
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
  const store = new BlobStore({ dataDir });
  await store.init();
  await seedLibrary(db, store, KEY, count);
  return { db, repo: new PhotosRepository(db), store };
}

describe('dev seed', () => {
  test('generated sample JPEGs are valid-shaped and unique per index', () => {
    const a = sampleJpeg(1);
    const b = sampleJpeg(2);
    assert.deepEqual([a[0], a[1]], [0xff, 0xd8]);
    assert.deepEqual([a.at(-2), a.at(-1)], [0xff, 0xd9]);
    assert.notDeepEqual(a, b);
  });

  test('seeds the mock shape through the real path, deterministically', async () => {
    const first = await seeded(16);
    const second = await seeded(16);

    const page = first.repo.page({ source: 'all', limit: 50 });
    assert.equal(page.photos.length, 16);
    // RAF every 5th, favorites every 9th (mock shape).
    const raf = page.photos.filter((photo) => photo.fileName.endsWith('.RAF'));
    assert.equal(raf.length, 4);
    assert.ok(page.photos.some((photo) => photo.favorite));
    assert.deepEqual(
      ['01J8SEEDPHOTO0000', '01J8SEEDPHOTO0001', '01J8SEEDPHOTO0002', '01J8SEEDPHOTO0003'].map((id) => {
        const photo = first.repo.get(id);
        return { width: photo?.width, height: photo?.height };
      }),
      [
        { width: 1280, height: 838 },
        { width: 960, height: 1280 },
        { width: 1280, height: 722 },
        { width: 960, height: 960 },
      ],
      'real seed metadata matches the fixture bytes used by aspect-sensitive rendering',
    );

    // Deterministic: same ids AND same content hashes across fresh seeds.
    const hashesA = page.photos.map((photo) => `${photo.id}:${photo.contentHash}`).sort();
    const hashesB = second.repo
      .page({ source: 'all', limit: 50 })
      .photos.map((photo) => `${photo.id}:${photo.contentHash}`)
      .sort();
    assert.deepEqual(hashesA, hashesB);

    // Statuses varied per the mock rotation.
    const statuses = queryAll<{ status: string; n: number }>(first.db, 'SELECT status, count(*) AS n FROM sync_ledger GROUP BY status');
    assert.ok(statuses.length >= 3);

    // Albums exist with deterministic membership.
    const albums = queryAll<{ name: string; members: number }>(
      first.db,
      `SELECT a.name, count(ap.photo_id) AS members FROM albums a
       LEFT JOIN album_photos ap ON ap.album_id = a.id GROUP BY a.id ORDER BY a.position`,
    );
    assert.deepEqual(
      albums.map((album) => album.name),
      [...SEED_ALBUMS],
    );
    assert.ok(albums.every((album) => album.members === 4));
  });

  test('seeded blobs decrypt through the real envelope path', async () => {
    const { repo, store } = await seeded(6);
    const photo = repo.page({ source: 'all', limit: 1 }).photos[0]!;
    const bytes = await buffer(store.getStream(photo.contentHash, (id) => (id === 1 ? KEY.key : undefined), photo.id));
    assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8]);
  });

  test('seeding a non-empty library is a no-op', async () => {
    const { db, repo, store } = await seeded(4);
    const result = await seedLibrary(db, store, KEY, 4);
    assert.deepEqual(result, { photos: 0, albums: 0 });
    assert.equal(repo.stats().photos, 4);
  });

  test('seed dates stay valid ISO at any index (month/year rollover)', async () => {
    const { db } = await seeded(2);
    seedSynthetic(db, 1, 'rollover', 1000);
    const bad = queryAll<{ taken_at: string }>(
      db,
      `SELECT taken_at FROM photos WHERE taken_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T*'`,
    );
    assert.deepEqual(bad, []);
    const months = queryAll<{ m: string }>(db, `SELECT DISTINCT substr(taken_at, 6, 2) AS m FROM photos`);
    for (const { m } of months) {
      const month = Number(m);
      assert.ok(month >= 1 && month <= 12, `invalid month ${m}`);
    }
  });

  test('synthetic variant inserts metadata-only rows fast', async () => {
    const { db, repo } = await seeded(2);
    const inserted = seedSynthetic(db, 1, 'synthetic', 5000);
    assert.equal(inserted, 5000);
    assert.equal(repo.stats().photos, 5002);
  });

  test('offline semantic fixtures cover every seeded photo and are idempotent', async () => {
    const { db } = await seeded(16);
    assert.equal(seedSemanticIndex(db, 0), 16);
    assert.equal(seedSemanticIndex(db, 0), 0);
    const query = new Int8Array(EMBEDDING_DIMENSIONS);
    query[0] = 127;
    const nearest = new EmbeddingRepository(db).nearest(EMBEDDING_MODEL_MANIFEST.version, query, { source: 'all' }, 1);
    assert.equal(nearest[0]?.photoId, '01J8SEEDPHOTO0000');
  });

  test('ordinary paging does not initialize semantic embeddings', async () => {
    const { db } = await seeded(4);
    const page = await new SemanticSearch(db).page({ source: 'all', limit: 1 }, () => {
      throw new Error('semantic embeddings must remain lazy without a search query');
    });
    assert.equal(page.photos.length, 1);
  });
});
