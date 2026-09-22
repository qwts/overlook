import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import type { PageCursor } from '../../src/shared/library/types.js';

test('200K synthetic rows: inclusion-filter cursor walks stay within the page budget', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'overlook-inclusion-perf-')), 'library.db');
  const db = openLibraryDatabase({ path, dbKey: randomBytes(32) });
  run(db, "INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped-test-key', ?)", new Date().toISOString());
  const repo = new PhotosRepository(db);
  try {
    const insert = db.prepare(
      `INSERT INTO photos (id, file_name, file_kind, width, height, bytes, content_hash, derivative_key,
          imported_at, import_source, favorite, key_id, taken_at, dimension_status, preview_failure)
         VALUES (?, ?, 'jpeg', ?, ?, 8400000, ?, ?, '2026-07-01T00:00:00.000Z', 'seed', 0, 1, ?, 'verified', ?)`,
    );
    const insertLedger = db.prepare("INSERT INTO sync_ledger (photo_id, status, dirty) VALUES (?, 'synced', 0)");
    db.transaction(() => {
      for (let i = 0; i < 200_000; i += 1) {
        const n = String(i).padStart(7, '0');
        const small = i % 10 === 0;
        insert.run(
          `01J8SEED${n}`,
          `IMG_${n}.JPG`,
          small ? 1000 : 6000,
          small ? 1000 : 4000,
          `seed-hash-${n}`,
          `seed-hash-${n}`,
          `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}T08:00:00.000Z`,
          i % 20 === 1 ? 'decode-failed' : null,
        );
        insertLedger.run(`01J8SEED${n}`);
      }
    })();

    // Retain the original cold first-page ceiling and baseline output.
    const started = process.hrtime.bigint();
    const first = repo.page({ source: 'all', limit: 200 });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    assert.equal(first.photos.length, 200);
    assert.notEqual(first.nextCursor, null);
    assert.ok(elapsedMs < 250, `page query took ${elapsedMs.toFixed(1)}ms`);
    console.log(`[baseline] 200K keyset page: ${elapsedMs.toFixed(1)}ms`);

    for (const scenario of [
      { name: 'unfiltered', showUnavailable: true, minimumMegapixels: null, count: 200_000 },
      { name: 'hide-unavailable', showUnavailable: false, minimumMegapixels: null, count: 190_000 },
      { name: 'minimum-4MP', showUnavailable: true, minimumMegapixels: 4, count: 180_000 },
      { name: 'combined', showUnavailable: false, minimumMegapixels: 4, count: 170_000 },
    ]) {
      repo.setGalleryPolicy({ showUnavailable: scenario.showUnavailable, minimumMegapixels: scenario.minimumMegapixels });
      const seen = new Set<string>();
      const timings: number[] = [];
      let cursor: PageCursor | null = null;
      do {
        const began = process.hrtime.bigint();
        const page = repo.page({ source: 'all', limit: 200, ...(cursor === null ? {} : { cursor }) });
        timings.push(Number(process.hrtime.bigint() - began) / 1_000_000);
        for (const photo of page.photos) {
          assert.equal(seen.has(photo.id), false, `${scenario.name}: duplicate cursor row ${photo.id}`);
          seen.add(photo.id);
          assert.equal(photo.syncState, 'synced', 'the page hydrates the settled production ledger row');
          if (!scenario.showUnavailable) assert.equal(photo.previewFailure, null);
          if (scenario.minimumMegapixels !== null) assert.ok(photo.width * photo.height >= 4_000_000);
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
      assert.equal(seen.size, scenario.count, `${scenario.name}: full filtered walk`);
      timings.sort((left, right) => left - right);
      const p50 = timings[Math.floor(timings.length * 0.5)];
      const p95 = timings[Math.floor(timings.length * 0.95)];
      const max = timings.at(-1);
      assert.ok(p50 !== undefined && p95 !== undefined && max !== undefined);
      console.log(
        `[baseline] 200K inclusion ${scenario.name}: pages=${String(timings.length)} rows=${String(seen.size)} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms`,
      );
      // 2026-09-22 calibration: slowest local/Ubuntu/Windows p95 = 188.25ms.
      // min(2 * 188.25, 250) = 250ms; evidence is in Testing-Strategy.md.
      // Ratchet the distribution, not a single scheduler pause. Preserve
      // the original cold first-page ceiling above; log max for diagnosis.
      assert.ok(p95 < 250, `${scenario.name}: p95 page ${p95.toFixed(2)}ms exceeds 250ms`);
    }
  } finally {
    db.close();
  }
});
