import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { queryAll } from '../../src/main/db/sql.js';
import type { PageCursor } from '../../src/shared/library/types.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'overlook-cursor-seek-'));
  const db = openLibraryDatabase({ path: join(directory, 'library.db'), dbKey: randomBytes(32) });
  db.prepare("INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped-test-key', '2026-07-01')").run();
  const insert = db.prepare(`INSERT INTO photos
    (id, file_name, file_kind, width, height, bytes, content_hash, derivative_key,
     imported_at, import_source, favorite, key_id, taken_at, dimension_status, preview_failure)
    VALUES (?, ?, 'jpeg', ?, 2000, ?, ?, ?, ?, 'seed', 0, 1, ?, 'verified', ?)`);
  const ledger = db.prepare("INSERT INTO sync_ledger (photo_id, status, dirty) VALUES (?, 'synced', 0)");
  for (let n = 0; n < 45; n += 1) {
    const id = `photo-${String(n).padStart(3, '0')}`;
    const day = n % 3 === 0 ? '2026-06-01' : '2026-07-01';
    insert.run(
      id,
      n % 3 === 0 ? 'Beta.jpg' : n % 2 === 0 ? 'alpha.jpg' : 'ALPHA.jpg',
      n % 5 === 0 ? 1000 : 3000,
      (n % 3) * 1000,
      id,
      id,
      day,
      n % 4 === 0 ? null : day,
      n % 7 === 0 ? 'decode-failed' : null,
    );
    ledger.run(id);
  }
  return { db, directory, repo: new PhotosRepository(db) };
}

const orders = {
  date: { sql: 'COALESCE(taken_at, imported_at) DESC, id DESC', index: 'idx_photos_sort' },
  name: { sql: 'lower(file_name), id', index: 'idx_photos_name' },
  size: { sql: 'bytes DESC, id DESC', index: 'idx_photos_size' },
} as const;

for (const order of ['date', 'name', 'size'] as const) {
  for (const filtered of [false, true]) {
    test(`${order} cursor seeks its index and walks ties exactly once (filtered=${String(filtered)})`, (context) => {
      const { db, directory, repo } = fixture();
      try {
        repo.setGalleryPolicy({ showUnavailable: !filtered, minimumMegapixels: filtered ? 4 : null });
        const first = repo.page({ source: 'all', order, limit: 4 });
        assert.ok(first.nextCursor);
        // Observe, rather than reconstruct, the repository's actual SQL. The
        // spy delegates to the real database and the resulting plan uses its
        // migrated production views, joins, indexes, and SQLCipher engine.
        const prepare = context.mock.method(db, 'prepare');
        repo.page({ source: 'all', order, limit: 4, cursor: first.nextCursor });
        const sql = prepare.mock.calls.map((call) => call.arguments[0]).find((candidate) => candidate.includes('@cursorKey'));
        prepare.mock.restore();
        assert.ok(sql, 'repository prepared a cursor query');
        const plan = queryAll<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${sql}`, {
          limit: 4,
          cursorKey: first.nextCursor.sortKey,
          cursorId: first.nextCursor.id,
          minimumPixels: filtered ? 4_000_000 : null,
        }).map((row) => row.detail);
        console.log(`[cursor-seek] ${order} filtered=${String(filtered)}: ${plan.join(' | ')}`);
        assert.ok(
          plan.some((detail) => detail.startsWith('SEARCH ') && detail.includes(`INDEX ${orders[order].index}`)),
          `cursor must seek rather than scan earlier pages: ${plan.join(' | ')}`,
        );
        assert.ok(
          plan.every((detail) => !detail.includes('TEMP B-TREE')),
          'cursor order must not require a temp sort',
        );

        const expected = queryAll<{ id: string }>(
          db,
          `SELECT id FROM photos ${filtered ? 'WHERE preview_failure IS NULL AND width * height >= 4000000' : ''}
           ORDER BY ${orders[order].sql}`,
        ).map((row) => row.id);
        const seen: string[] = [];
        let cursor: PageCursor | null = null;
        do {
          const page = repo.page({ source: 'all', order, limit: 4, ...(cursor === null ? {} : { cursor }) });
          seen.push(...page.photos.map((photo) => photo.id));
          cursor = page.nextCursor;
          assert.ok(seen.length <= expected.length, 'cursor must advance through tied keys');
        } while (cursor !== null);
        assert.deepEqual(seen, expected, 'full order, null-date fallback, and tied IDs remain exact');
      } finally {
        db.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
