import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { run } from '../../src/main/db/sql.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import type { PageCursor, PhotoInsert, SourceFilter } from '../../src/shared/library/types.js';

// #119: every sidebar source returns exactly what it promises — the count
// and the page walk come from ONE where-clause, so this property test holds
// by construction (counts() reuses page()'s sourceWhere) and pins it
// against future drift. Chips AND with sources; 'Local only' means ledger
// status, not "not offloaded".

const RECENT_SINCE = '2026-07-01T00:00:00.000Z';

let seq = 0;
function photo(overrides: Partial<PhotoInsert> = {}): PhotoInsert {
  seq += 1;
  const n = String(seq).padStart(6, '0');
  return {
    id: `01J8TRUTH${n}`,
    fileName: `IMG_${n}.JPG`,
    fileKind: 'jpeg',
    width: 100,
    height: 100,
    bytes: 1000 + seq,
    contentHash: `truth-hash-${n}`,
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

/** A mixed world exercising every source and chip: favorites, fresh
 * imports, raw kinds, offloaded/synced/local ledger rows, deleted rows. */
function world(): { repo: PhotosRepository; db: ReturnType<typeof openLibraryDatabase> } {
  const db = openLibraryDatabase({ path: join(mkdtempSync(join(tmpdir(), 'overlook-truth-')), 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-01-01T00:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  repo.insert(photo({ favorite: true }));
  repo.insert(photo({ favorite: true, fileKind: 'raw', fileName: 'A.RAF' }));
  repo.insert(photo({ importedAt: '2026-07-10T00:00:00.000Z' }));
  repo.insert(photo({ importedAt: '2026-07-12T00:00:00.000Z', fileKind: 'raw', fileName: 'B.RAF' }));
  repo.insert(photo());
  repo.insert(photo());
  // Ledger variety: one offloaded, one synced, rest stay local.
  run(db, `UPDATE sync_ledger SET status = 'offloaded', dirty = 0 WHERE photo_id = '01J8TRUTH${String(seq - 1).padStart(6, '0')}'`);
  run(db, `UPDATE sync_ledger SET status = 'synced', dirty = 0 WHERE photo_id = '01J8TRUTH${String(seq).padStart(6, '0')}'`);
  // Two deleted rows (one of them a favorite) — invisible everywhere but
  // the trash (soft-delete flows land with #120; the column is ADR-0005).
  repo.insert(photo({ favorite: true }));
  run(db, `UPDATE photos SET deleted_at = '2026-07-11T00:00:00.000Z' WHERE id = '01J8TRUTH${String(seq).padStart(6, '0')}'`);
  repo.insert(photo());
  run(db, `UPDATE photos SET deleted_at = '2026-07-11T01:00:00.000Z' WHERE id = '01J8TRUTH${String(seq).padStart(6, '0')}'`);
  return { repo, db };
}

function walk(repo: PhotosRepository, source: SourceFilter, chips?: Parameters<PhotosRepository['page']>[0]['chips']): string[] {
  const seen: string[] = [];
  let cursor: PageCursor | undefined;
  for (;;) {
    const page = repo.page({
      source,
      limit: 2, // tiny pages so the cursor itself is under test
      ...(source === 'recent' ? { recentSince: RECENT_SINCE } : {}),
      ...(chips === undefined ? {} : { chips }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    seen.push(...page.photos.map((row) => row.id));
    if (page.nextCursor === null) {
      return seen;
    }
    cursor = page.nextCursor;
  }
}

describe('source truth (#119)', () => {
  test('EXIT CRITERIA: for every source, sidebar count === full page-walk total', () => {
    const { repo, db } = world();
    const counts = repo.counts(RECENT_SINCE);
    for (const source of ['all', 'favorites', 'recent', 'offloaded', 'deleted'] as const) {
      const ids = walk(repo, source);
      assert.equal(counts[source], ids.length, `${source}: count ${String(counts[source])} vs walk ${String(ids.length)}`);
      assert.equal(new Set(ids).size, ids.length, `${source}: no duplicates across pages`);
    }
    // And the world actually exercises every source.
    assert.deepEqual(counts, { all: 6, favorites: 2, recent: 2, offloaded: 1, deleted: 2 });
    db.close();
  });

  test('chips AND with sources: favorites∧raw, recent∧raw, localOnly means ledger-local', () => {
    const { repo, db } = world();
    assert.equal(walk(repo, 'favorites', { raw: true }).length, 1, 'favorite AND raw');
    assert.equal(walk(repo, 'recent', { raw: true }).length, 1, 'recent AND raw');
    // 6 live minus one offloaded minus one synced = 4 ledger-local rows.
    assert.equal(walk(repo, 'all', { localOnly: true }).length, 4, 'localOnly is status=local, not "not offloaded"');
    assert.equal(walk(repo, 'all', { offloaded: true }).length, 1);
    // Chip combos AND down to the empty set honestly.
    assert.equal(walk(repo, 'all', { offloaded: true, localOnly: true }).length, 0, 'contradictory chips yield nothing');
    db.close();
  });

  test('deleted rows are invisible to every non-trash source and chip combo', () => {
    const { repo, db } = world();
    for (const source of ['all', 'favorites', 'recent', 'offloaded'] as const) {
      for (const id of walk(repo, source)) {
        assert.ok(!walk(repo, 'deleted').includes(id), `${source} leaked a deleted row`);
      }
    }
    // The deleted favorite counts in trash, not in Favorites.
    assert.equal(repo.counts(RECENT_SINCE).favorites, 2);
    assert.equal(walk(repo, 'deleted').length, 2);
    db.close();
  });
});
