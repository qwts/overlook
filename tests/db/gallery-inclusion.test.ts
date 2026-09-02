import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { readGalleryPolicy, writeGalleryPolicy } from '../../src/main/db/gallery-policy-repository.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import { DEFAULT_GALLERY_POLICY } from '../../src/shared/library/gallery-policy.js';
import type { PageCursor, PhotoInsert, SourceFilter } from '../../src/shared/library/types.js';

// #512 / ADR-0030 §4: Unavailable and RAW are derived sources; All Photos
// inclusion rules compile into the same clause for the page and its count;
// unknown dimensions are never zero megapixels; exclusion is presentation
// only (albums and explicit search see every row).

const RECENT_SINCE = '2026-07-01T00:00:00.000Z';

let seq = 0;
function photo(overrides: Partial<PhotoInsert> = {}): PhotoInsert {
  seq += 1;
  const n = String(seq).padStart(6, '0');
  return {
    id: `01J8INCL${n}`,
    fileName: `IMG_${n}.JPG`,
    fileKind: 'jpeg',
    width: 4000,
    height: 3000,
    bytes: 1000 + seq,
    contentHash: `incl-hash-${n}`,
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
  readonly large: string;
  readonly raw: string;
  readonly tiny: string;
  readonly unknown: string;
  readonly broken: string;
  readonly undecodable: string;
}

function world(): { repo: PhotosRepository; db: ReturnType<typeof openLibraryDatabase>; ids: WorldIds } {
  const db = openLibraryDatabase({ path: join(mkdtempSync(join(tmpdir(), 'overlook-inclusion-')), 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-01-01T00:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  const large = photo();
  const raw = photo({ fileKind: 'raw', fileName: 'A.RAF', width: 6000, height: 4000 });
  const tiny = photo({ width: 160, height: 160 });
  const unknown = photo({ width: 0, height: 0 });
  const broken = photo();
  const undecodable = photo({ fileKind: 'raw', fileName: 'B.RAF' });
  const deletedTiny = photo({ width: 160, height: 160 });
  for (const row of [large, raw, tiny, unknown, broken, undecodable, deletedTiny]) repo.insert(row);
  repo.setPreviewFailure(broken.id, 'decode-failed');
  repo.setDimensionStatus(unknown.id, 'unavailable');
  repo.setDimensionStatus(undecodable.id, 'unavailable');
  run(db, `UPDATE photos SET deleted_at = '2026-07-11T00:00:00.000Z' WHERE id = ?`, deletedTiny.id);
  repo.createAlbum('ALB', 'Everything');
  repo.addToAlbum('ALB', [large.id, tiny.id, unknown.id, broken.id]);
  return {
    repo,
    db,
    ids: { large: large.id, raw: raw.id, tiny: tiny.id, unknown: unknown.id, broken: broken.id, undecodable: undecodable.id },
  };
}

function walk(repo: PhotosRepository, source: SourceFilter, extra: Partial<Parameters<PhotosRepository['page']>[0]> = {}): string[] {
  const seen: string[] = [];
  let cursor: PageCursor | undefined;
  for (;;) {
    const page = repo.page({ source, limit: 2, recentSince: RECENT_SINCE, ...extra, ...(cursor === undefined ? {} : { cursor }) });
    seen.push(...page.photos.map((row) => row.id));
    if (page.nextCursor === null) return seen.sort();
    cursor = page.nextCursor;
  }
}

describe('gallery inclusion rules (#512, ADR-0030 §4)', () => {
  test('the migration seeds the ADR defaults and the policy round-trips', () => {
    const { db } = world();
    assert.deepEqual(readGalleryPolicy(db), DEFAULT_GALLERY_POLICY);
    assert.deepEqual(writeGalleryPolicy(db, { showUnavailable: false, minimumMegapixels: 2 }), {
      showUnavailable: false,
      minimumMegapixels: 2,
    });
    assert.deepEqual(readGalleryPolicy(db), { showUnavailable: false, minimumMegapixels: 2 });
    assert.throws(() => writeGalleryPolicy(db, { showUnavailable: true, minimumMegapixels: -1 }));
    db.close();
  });

  test('RAW and Unavailable are derived sources with exact counts', () => {
    const { repo, db, ids } = world();
    const counts = repo.counts(RECENT_SINCE);
    assert.deepEqual(walk(repo, 'raw'), [ids.raw, ids.undecodable].sort());
    assert.deepEqual(walk(repo, 'unavailable'), [ids.broken, ids.undecodable, ids.unknown].sort());
    assert.equal(counts.raw, 2);
    assert.equal(counts.unavailable, 3);
    assert.equal(counts.all, 6, 'no rule active: every live row is in All Photos');
    assert.equal(counts.excluded, 0);
    db.close();
  });

  test('a 160×160 row follows the megapixel threshold; unknown dimensions never do', () => {
    const { repo, db, ids } = world();
    writeGalleryPolicy(db, { showUnavailable: true, minimumMegapixels: 1 });
    const all = walk(repo, 'all');
    assert.ok(!all.includes(ids.tiny), '0.0256 MP is below a 1 MP floor');
    assert.ok(all.includes(ids.unknown), 'unknown dimensions are not zero megapixels');
    assert.ok(all.includes(ids.undecodable));
    assert.ok(all.includes(ids.broken), 'unavailable rows stay visible while showUnavailable is on');
    const counts = repo.counts(RECENT_SINCE);
    assert.equal(counts.all, all.length, 'count and page walk share one clause');
    assert.equal(counts.excluded, 1);

    writeGalleryPolicy(db, { showUnavailable: true, minimumMegapixels: null });
    assert.ok(walk(repo, 'all').includes(ids.tiny), 'None / show every size restores the row');
    db.close();
  });

  test('hiding unavailable items removes them from All Photos only', () => {
    const { repo, db, ids } = world();
    writeGalleryPolicy(db, { showUnavailable: false, minimumMegapixels: null });
    const all = walk(repo, 'all');
    assert.deepEqual(all, [ids.large, ids.raw, ids.tiny].sort());
    const counts = repo.counts(RECENT_SINCE);
    assert.equal(counts.all, 3);
    assert.equal(counts.excluded, 3);
    assert.equal(counts.unavailable, 3, 'the Unavailable source still lists every hidden row');
    assert.deepEqual(walk(repo, 'raw'), [ids.raw, ids.undecodable].sort(), 'other sources are unaffected');
    assert.deepEqual(walk(repo, 'all', { albumId: 'ALB' }), [ids.broken, ids.large, ids.tiny, ids.unknown].sort(), 'albums are unaffected');
    assert.ok(walk(repo, 'all', { query: 'IMG' }).includes(ids.broken), 'explicit search is unaffected');
    assert.deepEqual([...repo.selectAllIds({ source: 'all' })].sort(), all, 'Select All follows the same clause');
    db.close();
  });

  test('repairing a row moves it out of Unavailable and back into All Photos without a rebuild', () => {
    const { repo, db, ids } = world();
    writeGalleryPolicy(db, { showUnavailable: false, minimumMegapixels: null });
    assert.ok(!walk(repo, 'all').includes(ids.broken));
    repo.setPreviewFailure(ids.broken, null);
    assert.ok(walk(repo, 'all').includes(ids.broken));
    assert.ok(!walk(repo, 'unavailable').includes(ids.broken));
    assert.ok(repo.repairGeneratedDimensions(ids.unknown, 800, 600));
    assert.ok(walk(repo, 'all').includes(ids.unknown));
    assert.equal(repo.counts(RECENT_SINCE).unavailable, 1);
    db.close();
  });

  test('the manifest carries the policy as library data', () => {
    const { repo, db } = world();
    writeGalleryPolicy(db, { showUnavailable: false, minimumMegapixels: 4 });
    assert.deepEqual(repo.galleryPolicy(), { showUnavailable: false, minimumMegapixels: 4 });
    db.close();
  });
});
