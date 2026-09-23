import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3-multiple-ciphers';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { run } from '../../src/main/db/sql.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { posterCaptureCandidates } from '../../src/main/db/poster-candidates.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

const DB_KEY = randomBytes(32);
let seq = 0;

function photo(overrides: Partial<PhotoInsert>): PhotoInsert {
  seq += 1;
  const n = String(seq).padStart(6, '0');
  return {
    id: `01J8VID${n}`,
    fileName: `IMG_${n}.ts`,
    fileKind: 'video',
    width: 0,
    height: 0,
    bytes: 42_000_000,
    contentHash: `hash-${n}`,
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
    importedAt: '2026-07-01T00:00:00.000Z',
    importSource: 'sd-card',
    keyId: 1,
    ...overrides,
  };
}

function openDb(): { db: Database.Database; repo: PhotosRepository } {
  const db = openLibraryDatabase({ path: join(mkdtempSync(join(tmpdir(), 'overlook-poster-')), 'library.db'), dbKey: DB_KEY });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped-test-key', ?)`, new Date().toISOString());
  return { db, repo: new PhotosRepository(db) };
}

describe('posterCaptureCandidates (#548, ADR-0026 §6)', () => {
  test('returns local video rows only — never stills, deleted, or offloaded', () => {
    const { db, repo } = openDb();
    const local = photo({});
    const still = photo({ fileKind: 'jpeg' });
    const offloaded = photo({});
    const deleted = photo({});
    for (const p of [local, still, offloaded, deleted]) repo.insert(p);
    run(db, "UPDATE sync_ledger SET status = 'offloaded' WHERE photo_id = ?", offloaded.id);
    run(db, "UPDATE photos SET deleted_at = '2026-07-02T00:00:00.000Z' WHERE id = ?", deleted.id);

    assert.deepEqual(
      posterCaptureCandidates(db).map(({ id }) => id),
      [local.id],
    );
    assert.deepEqual(posterCaptureCandidates(db, [offloaded.id, deleted.id, still.id]), []);
    assert.deepEqual(
      posterCaptureCandidates(db, [local.id]).map(({ id }) => id),
      [local.id],
    );
  });
});
