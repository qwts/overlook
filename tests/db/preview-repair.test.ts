import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

import { migrate, MIGRATIONS } from '../../src/main/db/migrations.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { VariantRepository } from '../../src/main/db/variant-repository.js';
import { UNAVAILABLE_WHERE } from '../../src/main/db/photo-clauses.js';
import { run, queryGet, queryAll } from '../../src/main/db/sql.js';

test('schemas 41/42 queue older variants without declaring them unavailable before verification', () => {
  const db = new Database(':memory:');
  try {
    migrate(
      db,
      MIGRATIONS.filter((migration) => migration.version < 41),
    );
    run(db, "INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-09-21')");
    const repo = new PhotosRepository(db);
    repo.insert({
      id: 'root',
      fileName: 'root.jpg',
      fileKind: 'jpeg',
      width: 60,
      height: 40,
      bytes: 42,
      contentHash: 'a'.repeat(64),
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
      importedAt: '2026-09-21',
      importSource: 'test',
      keyId: 1,
    });
    repo.setDimensionStatus('root', 'verified');
    const root = repo.get('root');
    assert.ok(root);
    const variants = new VariantRepository(db);
    variants.duplicate(root, 'sibling', '2026-09-21');
    variants.duplicate(root, 'trashed', '2026-09-21');
    repo.softDelete(['root', 'trashed']);
    run(db, "UPDATE sync_ledger SET dirty = 0, status = 'offloaded'");
    assert.equal(migrate(db), 5);
    assert.equal(migrate(db), 0);
    // INDEXED BY fails preparation if the partial index cannot serve this predicate.
    const plan = queryAll<{ detail: string }>(
      db,
      `EXPLAIN QUERY PLAN SELECT p.id FROM photos p INDEXED BY idx_photos_unavailable WHERE ${UNAVAILABLE_WHERE}`,
    );
    assert.ok(plan.some((step) => step.detail.includes('idx_photos_unavailable')));
    const facet = (value: 'available' | 'unavailable'): string[] =>
      repo
        .page({
          source: 'all',
          limit: 20,
          predicate: { version: 1, composition: 'and', groups: [{ facet: 'availability', values: [value] }] },
        })
        .photos.map((row) => row.id);
    assert.equal(repo.get('root')?.previewFailure, null);
    assert.equal(repo.get('sibling')?.previewFailure, null, 'verification debt alone is not missing previews');
    assert.equal(repo.page({ source: 'unavailable', limit: 20 }).photos.length, 0);
    repo.setGalleryPolicy({ showUnavailable: false, minimumMegapixels: null });
    assert.deepEqual(
      repo.page({ source: 'all', limit: 20 }).photos.map((row) => row.id),
      ['sibling'],
    );
    assert.deepEqual(facet('available'), ['sibling']);
    assert.deepEqual(facet('unavailable'), []);
    repo.setPreviewMissing('sibling', true);
    assert.deepEqual(
      repo.page({ source: 'unavailable', limit: 20 }).photos.map((row) => row.id),
      ['sibling'],
    );
    repo.setGalleryPolicy({ showUnavailable: true, minimumMegapixels: null });
    assert.deepEqual(facet('unavailable'), ['sibling']);
    assert.deepEqual(facet('available'), []);
    repo.setGalleryPolicy({ showUnavailable: false, minimumMegapixels: null });
    assert.equal(repo.get('sibling')?.previewFailure, 'deferred-original');
    assert.equal(repo.page({ source: 'all', limit: 20 }).photos.length, 0);
    assert.deepEqual(
      repo.previewRepairCandidates(['a'.repeat(64)]).map((photo) => photo.id),
      ['sibling'],
    );
    assert.deepEqual(repo.previewRepairCandidates(['b'.repeat(64)]), []);
    assert.equal(repo.clearPreviewRepairDebt('sibling'), true);
    assert.equal(repo.get('sibling')?.previewFailure, null);
    assert.deepEqual(facet('available'), ['sibling']);
    assert.deepEqual(facet('unavailable'), []);
    assert.equal(repo.page({ source: 'unavailable', limit: 20 }).photos.length, 0);
    assert.equal(repo.page({ source: 'all', limit: 20 }).photos.length, 1);
    assert.equal(queryGet<{ n: number }>(db, 'SELECT count(*) AS n FROM sync_ledger WHERE dirty = 1')?.n, 0);
    for (const fileKind of ['gif', 'webp', 'video', 'audio'] as const) {
      const id = `source-${fileKind}`;
      const hash = createHash('sha256').update(fileKind).digest('hex');
      repo.insert({ ...root, id, fileKind, contentHash: hash, derivativeKey: hash });
      const source = repo.get(id);
      assert.ok(source);
      variants.duplicate(source, `copy-${fileKind}`, '2026-09-21');
      assert.equal(repo.get(`copy-${fileKind}`)?.previewFailure, fileKind === 'gif' || fileKind === 'webp' ? 'deferred-original' : null);
    }
  } finally {
    db.close();
  }
});
