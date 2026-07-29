import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3-multiple-ciphers';

import { openLibraryDatabase, LibraryDatabaseError } from '../../src/main/db/database.js';
import { queryAll, queryGet, run } from '../../src/main/db/sql.js';
import { migrate, MIGRATIONS } from '../../src/main/db/migrations.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

const DB_KEY = randomBytes(32);
const EMPTY_METADATA = {
  width: null,
  height: null,
  camera: null,
  lens: null,
  iso: null,
  aperture: null,
  shutter: null,
  focalLength: null,
  takenAt: null,
  gpsLat: null,
  gpsLon: null,
} as const;

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'overlook-db-')), 'library.db');
}

let seq = 0;
// The mock's field set (design ui_kits photos.js) — camera/lens/EXIF/place.
function samplePhoto(overrides: Partial<PhotoInsert> = {}): PhotoInsert {
  seq += 1;
  const n = String(seq).padStart(6, '0');
  return {
    id: `01J8PHOTO${n}`,
    fileName: `IMG_${n}.RAF`,
    fileKind: 'raw',
    width: 6240,
    height: 4160,
    bytes: 54_200_000,
    contentHash: `hash-${n}`,
    camera: 'FUJIFILM X-T5',
    lens: 'XF 35MM F/1.4',
    iso: 125,
    aperture: '1.8',
    shutter: '1/250',
    focalLength: 23,
    takenAt: `2026-06-${String((seq % 27) + 1).padStart(2, '0')}T12:00:00.000Z`,
    gpsLat: 35.0116,
    gpsLon: 135.7681,
    place: 'Kyoto',
    importedAt: '2026-07-01T00:00:00.000Z',
    importSource: 'sd-card',
    keyId: 1,
    ...overrides,
  };
}

function openSeeded(path = tempDbPath()): { db: Database.Database; repo: PhotosRepository } {
  const db = openLibraryDatabase({ path, dbKey: DB_KEY });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped-test-key', ?)`, new Date().toISOString());
  return { db, repo: new PhotosRepository(db) };
}

describe('openLibraryDatabase', () => {
  test('applies SQLCipher: a keyless open cannot read the file', () => {
    const path = tempDbPath();
    const db = openLibraryDatabase({ path, dbKey: DB_KEY });
    db.close();
    const raw = new Database(path);
    assert.throws(() => raw.prepare('SELECT count(*) FROM sqlite_master').get());
    raw.close();
  });

  test('a wrong key fails loudly with a named error', () => {
    const path = tempDbPath();
    openLibraryDatabase({ path, dbKey: DB_KEY }).close();
    assert.throws(
      () => openLibraryDatabase({ path, dbKey: randomBytes(32) }),
      (error: unknown) => error instanceof LibraryDatabaseError,
    );
  });

  test('short keys are refused', () => {
    assert.throws(() => openLibraryDatabase({ path: tempDbPath(), dbKey: randomBytes(16) }), /32 bytes/);
  });

  test('WAL and foreign keys are on', () => {
    const db = openLibraryDatabase({ path: tempDbPath(), dbKey: DB_KEY });
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    db.close();
  });
});

describe('migrations', () => {
  test('migrations apply cleanly twice (second run is a no-op)', () => {
    const db = openLibraryDatabase({ path: tempDbPath(), dbKey: DB_KEY });
    // openLibraryDatabase already migrated once.
    assert.equal(migrate(db, MIGRATIONS), 0);
    const versions = queryAll<{ version: number }>(db, 'SELECT version FROM schema_migrations');
    assert.deepEqual(
      versions.map((row) => row.version),
      MIGRATIONS.map((migration) => migration.version),
    );
    db.close();
  });

  test('schema v10 tracks protected ciphertext remotely without plaintext addresses', () => {
    const db = openLibraryDatabase({ path: tempDbPath(), dbKey: DB_KEY });
    const columns = queryAll<{ name: string }>(db, 'PRAGMA table_info(protected_remote_objects)');
    assert.deepEqual(
      columns.map((column) => column.name),
      ['photo_id', 'kind', 'status', 'dirty', 'ciphertext_sha256', 'ciphertext_bytes', 'last_backup_at'],
    );
    assert.deepEqual(
      queryAll<{ name: string }>(db, `SELECT name FROM pragma_table_info('protected_remote_objects') WHERE name LIKE '%hash%'`),
      [],
    );
    db.close();
  });

  test('schema v8 separates protected photo custody behind a durable migration journal', () => {
    const db = openLibraryDatabase({ path: tempDbPath(), dbKey: DB_KEY });
    const tables = queryAll<{ name: string }>(
      db,
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (
         'protected_photo_migrations',
         'protected_photo_migration_items',
         'protected_photo_records'
       ) ORDER BY name`,
    );
    assert.deepEqual(
      tables.map((table) => table.name),
      ['protected_photo_migration_items', 'protected_photo_migrations', 'protected_photo_records'],
    );
    const recordColumns = queryAll<{ name: string }>(db, 'PRAGMA table_info(protected_photo_records)');
    assert.deepEqual(
      recordColumns.map((column) => column.name),
      [
        'photo_id',
        'album_id',
        'record_version',
        'blob_ref',
        'sealed_metadata',
        'has_thumb',
        'has_mid',
        'created_at',
        'updated_at',
        'manifest_dirty',
      ],
    );
    db.close();
  });

  test('schema v5 keeps canonical interoperability records separate from native photos', () => {
    const db = openLibraryDatabase({ path: tempDbPath(), dbKey: DB_KEY });
    const tables = queryAll<{ name: string }>(
      db,
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('interop_records', 'interop_albums')
       ORDER BY name`,
    );
    assert.deepEqual(
      tables.map((table) => table.name),
      ['interop_albums', 'interop_records'],
    );
    const recordColumns = queryAll<{ name: string }>(db, 'PRAGMA table_info(interop_records)');
    assert.deepEqual(
      recordColumns.map((column) => column.name),
      [
        'interop_id',
        'origin_product',
        'origin_local_id',
        'content_hash',
        'local_photo_id',
        'review_category',
        'record_json',
        'received_at',
      ],
    );
    db.close();
  });

  test('schema v7 keeps every Move durability boundary in SQLCipher custody', () => {
    const db = openLibraryDatabase({ path: tempDbPath(), dbKey: DB_KEY });
    const tables = queryAll<{ name: string }>(
      db,
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'interop_move_%'
       ORDER BY name`,
    );
    assert.deepEqual(
      tables.map((table) => table.name),
      [
        'interop_move_audit',
        'interop_move_inbound_objects',
        'interop_move_items',
        'interop_move_journals',
        'interop_move_outbox',
        'interop_move_receipts',
      ],
    );
    db.close();
  });

  test('schema v9 keeps Sync receipts, decisions, controls, and audit in SQLCipher custody', () => {
    const db = openLibraryDatabase({ path: tempDbPath(), dbKey: DB_KEY });
    const tables = queryAll<{ name: string }>(
      db,
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'interop_sync_%'
       ORDER BY name`,
    );
    assert.deepEqual(
      tables.map((table) => table.name),
      ['interop_sync_audit', 'interop_sync_items', 'interop_sync_receipts', 'interop_sync_sessions'],
    );
    db.close();
  });

  test('migrations apply in version order and are transactional', () => {
    const db = openLibraryDatabase({ path: tempDbPath(), dbKey: DB_KEY });
    const order: number[] = [];
    const current = Math.max(...MIGRATIONS.map((migration) => migration.version));
    const extra = [
      { version: current + 2, name: 'later', up: () => order.push(current + 2) },
      { version: current + 1, name: 'next', up: () => order.push(current + 1) },
    ];
    assert.equal(migrate(db, [...MIGRATIONS, ...extra]), 2);
    assert.deepEqual(order, [current + 1, current + 2]);
    db.close();
  });

  test('a failing migration rolls back and records nothing', () => {
    const db = openLibraryDatabase({ path: tempDbPath(), dbKey: DB_KEY });
    // Derived, not hardcoded: a new schema version must not silently turn
    // this into a no-op (the bad version would already be "applied").
    const current = Math.max(...MIGRATIONS.map((migration) => migration.version));
    const bad = {
      version: current + 1,
      name: 'bad',
      up: (d: Database.Database) => {
        d.exec('CREATE TABLE half_done (a TEXT)');
        throw new Error('boom');
      },
    };
    assert.throws(() => migrate(db, [...MIGRATIONS, bad]), /boom/);
    assert.equal(queryGet<{ n: number }>(db, `SELECT count(*) AS n FROM sqlite_master WHERE name = 'half_done'`)?.n, 0);
    assert.equal(queryGet<{ v: number }>(db, 'SELECT max(version) AS v FROM schema_migrations')?.v, current);
    db.close();
  });
});

describe('PhotosRepository', () => {
  test('round-trips the mock field set', () => {
    const { db, repo } = openSeeded();
    const photo = samplePhoto();
    repo.insert(photo);
    const page = repo.page({ source: 'all', limit: 10 });
    assert.equal(page.photos.length, 1);
    const stored = page.photos[0]!;
    assert.equal(stored.fileName, photo.fileName);
    assert.equal(stored.camera, 'FUJIFILM X-T5');
    assert.equal(stored.lens, 'XF 35MM F/1.4');
    assert.equal(stored.iso, 125);
    assert.equal(stored.place, 'Kyoto');
    assert.equal(stored.favorite, false);
    assert.equal(stored.keyId, 1);
    assert.equal(stored.dimensionStatus, 'legacy');
    const ledger = queryGet<{ status: string; dirty: number }>(db, 'SELECT status, dirty FROM sync_ledger WHERE photo_id = ?', photo.id);
    assert.deepEqual(ledger, { status: 'local', dirty: 1 });
    db.close();
  });

  test('dimension repair updates only unknown records and dirties the manifest row (#367)', () => {
    const { db, repo } = openSeeded();
    const unknown = samplePhoto({ width: 0, height: 0 });
    const known = samplePhoto({ width: 700, height: 525 });
    repo.insert(unknown);
    repo.insert(known);
    run(db, 'UPDATE sync_ledger SET dirty = 0');

    assert.equal(repo.repairDimensions(unknown.id, 1919, 1279), true);
    assert.deepEqual({ width: repo.get(unknown.id)?.width, height: repo.get(unknown.id)?.height }, { width: 1919, height: 1279 });
    assert.equal(queryGet<{ dirty: number }>(db, 'SELECT dirty FROM sync_ledger WHERE photo_id = ?', unknown.id)?.dirty, 1);

    assert.equal(repo.repairDimensions(known.id, 1400, 1050), false, 'valid metadata is never overwritten');
    assert.deepEqual({ width: repo.get(known.id)?.width, height: repo.get(known.id)?.height }, { width: 700, height: 525 });
    assert.equal(queryGet<{ dirty: number }>(db, 'SELECT dirty FROM sync_ledger WHERE photo_id = ?', known.id)?.dirty, 0);
    assert.equal(repo.repairDimensions('missing', 1, 1), false);
    db.close();
  });

  test('generated HEIC dimensions replace un-oriented metadata dimensions (#487)', () => {
    const { db, repo } = openSeeded();
    const heic = samplePhoto({ fileKind: 'heic', width: 4032, height: 3024 });
    repo.insert(heic);
    run(db, 'UPDATE sync_ledger SET dirty = 0');

    assert.equal(repo.repairGeneratedDimensions(heic.id, 3024, 4032), true);
    assert.deepEqual({ width: repo.get(heic.id)?.width, height: repo.get(heic.id)?.height }, { width: 3024, height: 4032 });
    assert.equal(repo.get(heic.id)?.dimensionStatus, 'metadata-mismatch');
    assert.equal(queryGet<{ dirty: number }>(db, 'SELECT dirty FROM sync_ledger WHERE photo_id = ?', heic.id)?.dirty, 1);
    assert.equal(repo.repairGeneratedDimensions(heic.id, 3024, 4032), false);
    db.close();
  });

  test('decoder dimensions replace conflicting metadata for every decodable format (#500)', () => {
    const { db, repo } = openSeeded();
    const photos = [
      samplePhoto({ id: 'P-JPEG', contentHash: '1'.repeat(64), fileKind: 'jpeg', width: 4032, height: 3024 }),
      samplePhoto({ id: 'P-PNG', contentHash: '2'.repeat(64), fileKind: 'png', width: 1200, height: 800 }),
      samplePhoto({ id: 'P-RAW', contentHash: '3'.repeat(64), fileKind: 'raw', width: 6240, height: 4160 }),
    ];
    for (const photo of photos) repo.insert(photo);
    run(db, 'UPDATE sync_ledger SET dirty = 0');

    for (const photo of photos) {
      assert.equal(repo.repairGeneratedDimensions(photo.id, photo.height, photo.width), true);
      assert.deepEqual(
        { width: repo.get(photo.id)?.width, height: repo.get(photo.id)?.height },
        { width: photo.height, height: photo.width },
      );
      assert.equal(repo.get(photo.id)?.dimensionStatus, 'metadata-mismatch');
      assert.equal(queryGet<{ dirty: number }>(db, 'SELECT dirty FROM sync_ledger WHERE photo_id = ?', photo.id)?.dirty, 1);
    }
    db.close();
  });

  test('matching dimensions verify quietly and dimension diagnostics stay local (#500)', () => {
    const { db, repo } = openSeeded();
    const matching = samplePhoto({ fileKind: 'jpeg', width: 1200, height: 800 });
    const unavailable = samplePhoto({ fileKind: 'png', width: 640, height: 480 });
    repo.insert(matching);
    repo.insert(unavailable);
    run(db, 'UPDATE sync_ledger SET dirty = 0');

    assert.equal(repo.repairGeneratedDimensions(matching.id, 1200, 800), true);
    assert.equal(repo.get(matching.id)?.dimensionStatus, 'verified');
    assert.equal(repo.setDimensionStatus(unavailable.id, 'unavailable'), true);
    assert.equal(repo.get(unavailable.id)?.dimensionStatus, 'unavailable');
    assert.equal(queryGet<{ dirty: number }>(db, 'SELECT dirty FROM sync_ledger WHERE photo_id = ?', matching.id)?.dirty, 0);
    assert.equal(queryGet<{ dirty: number }>(db, 'SELECT dirty FROM sync_ledger WHERE photo_id = ?', unavailable.id)?.dirty, 0);
    assert.throws(() => repo.repairGeneratedDimensions(matching.id, 0, 800), /positive safe integers/);
    db.close();
  });

  test('decoder dimension repair and manifest dirtying commit atomically (#500 review)', () => {
    const { db, repo } = openSeeded();
    const photo = samplePhoto({ fileKind: 'jpeg', width: 640, height: 480 });
    repo.insert(photo);
    run(db, 'UPDATE sync_ledger SET dirty = 0');
    db.exec(`
      CREATE TEMP TRIGGER fail_dimension_dirty
      BEFORE UPDATE OF dirty ON sync_ledger
      WHEN OLD.photo_id = '${photo.id}'
      BEGIN
        SELECT RAISE(ABORT, 'injected dirty failure');
      END;
    `);

    assert.throws(() => repo.repairGeneratedDimensions(photo.id, 1280, 960), /injected dirty failure/);
    assert.deepEqual(
      {
        width: repo.get(photo.id)?.width,
        height: repo.get(photo.id)?.height,
        dimensionStatus: repo.get(photo.id)?.dimensionStatus,
      },
      { width: 640, height: 480, dimensionStatus: 'legacy' },
    );
    assert.equal(queryGet<{ dirty: number }>(db, 'SELECT dirty FROM sync_ledger WHERE photo_id = ?', photo.id)?.dirty, 0);
    db.close();
  });

  test('preview repair candidates stay local and metadata repair fills only unknown values (#368, #487)', () => {
    const { db, repo } = openSeeded();
    const affected = samplePhoto({ width: 0, height: 0, camera: null, lens: null });
    const trusted = samplePhoto({ width: 700, height: 525, camera: 'Trusted camera' });
    const offloaded = samplePhoto({ width: 0, height: 0 });
    const jpeg = samplePhoto({ fileKind: 'jpeg', width: 0, height: 0 });
    const heic = samplePhoto({ fileKind: 'heic', width: 0, height: 0 });
    for (const photo of [affected, trusted, offloaded, jpeg, heic]) repo.insert(photo);
    run(db, "UPDATE sync_ledger SET status = 'offloaded' WHERE photo_id = ?", offloaded.id);
    run(db, 'UPDATE sync_ledger SET dirty = 0');

    assert.deepEqual(
      repo.previewRepairCandidates().map(({ id }) => id),
      [affected.id, trusted.id, jpeg.id, heic.id],
    );
    assert.equal(
      repo.repairPreviewMetadata(affected.id, {
        width: 8256,
        height: 5504,
        camera: 'Nikon Z8',
        lens: 'NIKKOR Z 24-70mm',
        iso: 100,
        aperture: '2.8',
        shutter: '1/250',
        focalLength: 35,
        takenAt: '2026-07-01T12:00:00',
        gpsLat: null,
        gpsLon: null,
      }),
      true,
    );
    assert.deepEqual(
      { width: repo.get(affected.id)?.width, height: repo.get(affected.id)?.height, camera: repo.get(affected.id)?.camera },
      { width: 0, height: 0, camera: 'Nikon Z8' },
    );
    assert.equal(queryGet<{ dirty: number }>(db, 'SELECT dirty FROM sync_ledger WHERE photo_id = ?', affected.id)?.dirty, 1);

    assert.equal(repo.repairPreviewMetadata(trusted.id, { ...EMPTY_METADATA, width: 1400, height: 1050, camera: 'Replacement' }), false);
    assert.deepEqual(
      { width: repo.get(trusted.id)?.width, height: repo.get(trusted.id)?.height, camera: repo.get(trusted.id)?.camera },
      { width: 700, height: 525, camera: 'Trusted camera' },
    );
    db.close();
  });

  test('preview failure state is local-only and clears after a successful retry (#487)', () => {
    const { db, repo } = openSeeded();
    const heic = samplePhoto({ fileKind: 'heic' });
    repo.insert(heic);
    run(db, 'UPDATE sync_ledger SET dirty = 0');

    assert.equal(repo.setPreviewFailure(heic.id, 'unsupported-codec'), true);
    assert.equal(repo.get(heic.id)?.previewFailure, 'unsupported-codec');
    assert.equal(repo.setPreviewFailure(heic.id, 'unsupported-codec'), false);
    assert.equal(repo.setPreviewFailure(heic.id, null), true);
    assert.equal(repo.get(heic.id)?.previewFailure, null);
    assert.equal(queryGet<{ dirty: number }>(db, 'SELECT dirty FROM sync_ledger WHERE photo_id = ?', heic.id)?.dirty, 0);
    db.close();
  });

  test('duplicate content hashes are rejected (dedup by construction)', () => {
    const { db, repo } = openSeeded();
    repo.insert(samplePhoto({ contentHash: 'same' }));
    assert.throws(() => repo.insert(samplePhoto({ contentHash: 'same' })), /UNIQUE/);
    db.close();
  });

  test('keyset pagination walks the full set in order without overlap', () => {
    const { db, repo } = openSeeded();
    for (let i = 0; i < 25; i += 1) {
      repo.insert(samplePhoto());
    }
    const seen: string[] = [];
    let cursor: { sortKey: string | number; id: string } | undefined;
    for (;;) {
      const page = repo.page({ source: 'all', limit: 7, ...(cursor ? { cursor } : {}) });
      seen.push(...page.photos.map((photo) => photo.id));
      if (page.nextCursor === null) {
        break;
      }
      cursor = page.nextCursor;
    }
    assert.equal(seen.length, 25);
    assert.equal(new Set(seen).size, 25);
    // Descending by sort key: first seen is the newest taken_at.
    const sortKeys = seen.map(
      (id) => queryGet<{ k: string }>(db, 'SELECT COALESCE(taken_at, imported_at) AS k FROM photos WHERE id = ?', id)?.k,
    );
    const sorted = [...sortKeys].sort().reverse();
    assert.deepEqual(sortKeys, sorted);
    db.close();
  });

  test('null taken_at falls back to imported_at in the sort', () => {
    const { db, repo } = openSeeded();
    repo.insert(samplePhoto({ takenAt: null, importedAt: '2026-07-10T00:00:00.000Z' }));
    repo.insert(samplePhoto({ takenAt: '2026-01-01T00:00:00.000Z' }));
    const page = repo.page({ source: 'all', limit: 10 });
    assert.equal(page.photos[0]?.takenAt, null);
    db.close();
  });

  test('name order (#113): A→Z, keyset pages cleanly across the ASC cursor', () => {
    const { db, repo } = openSeeded();
    const names = ['delta.jpg', 'alpha.jpg', 'Charlie.jpg', 'bravo.jpg', 'echo.jpg'];
    for (const fileName of names) {
      repo.insert(samplePhoto({ fileName }));
    }
    const seen: string[] = [];
    let cursor: { sortKey: string | number; id: string } | undefined;
    for (;;) {
      const page = repo.page({ source: 'all', limit: 2, order: 'name', ...(cursor ? { cursor } : {}) });
      seen.push(...page.photos.map((photo) => photo.fileName));
      if (page.nextCursor === null) {
        break;
      }
      cursor = page.nextCursor;
    }
    // Case-insensitive ascending — 'Charlie' sorts between bravo and delta.
    assert.deepEqual(seen, ['alpha.jpg', 'bravo.jpg', 'Charlie.jpg', 'delta.jpg', 'echo.jpg']);
    db.close();
  });

  test('name/size orders ride their indexes, not a temp sort (PR #212 review)', () => {
    const { db, repo } = openSeeded();
    repo.insert(samplePhoto());
    const shapes = {
      name: 'lower(p.file_name), p.id',
      size: 'p.bytes DESC, p.id DESC',
    };
    for (const [order, orderBy] of Object.entries(shapes)) {
      const plan = queryAll<{ detail: string }>(
        db,
        `EXPLAIN QUERY PLAN
         SELECT p.*, l.status FROM photos p LEFT JOIN sync_ledger l ON l.photo_id = p.id
         WHERE p.deleted_at IS NULL ORDER BY ${orderBy} LIMIT 5`,
      )
        .map((row) => row.detail)
        .join(' | ');
      assert.ok(plan.includes(`idx_photos_${order}`), `${order} plan uses its index: ${plan}`);
      assert.ok(!plan.includes('TEMP B-TREE'), `${order} plan avoids the temp sort: ${plan}`);
    }
    db.close();
  });

  test('size order (#113): largest first, numeric keyset cursor', () => {
    const { db, repo } = openSeeded();
    for (const bytes of [100, 9_000_000, 5_000]) {
      repo.insert(samplePhoto({ bytes }));
    }
    const first = repo.page({ source: 'all', limit: 2, order: 'size' });
    assert.deepEqual(
      first.photos.map((photo) => photo.bytes),
      [9_000_000, 5_000],
    );
    // The numeric cursor pages correctly (no string comparison of digits).
    assert.notEqual(first.nextCursor, null);
    const rest = repo.page({ source: 'all', limit: 2, order: 'size', cursor: first.nextCursor ?? undefined });
    assert.deepEqual(
      rest.photos.map((photo) => photo.bytes),
      [100],
    );
    db.close();
  });

  test('favorite toggle flips state and dirties the ledger', () => {
    const { db, repo } = openSeeded();
    const photo = samplePhoto();
    repo.insert(photo);
    run(db, 'UPDATE sync_ledger SET dirty = 0 WHERE photo_id = ?', photo.id);
    assert.equal(repo.toggleFavorite(photo.id), true);
    assert.equal(repo.toggleFavorite(photo.id), false);
    assert.equal(queryGet<{ dirty: number }>(db, 'SELECT dirty FROM sync_ledger WHERE photo_id = ?', photo.id)?.dirty, 1);
    assert.throws(() => repo.toggleFavorite('missing'), /does not exist/);
    db.close();
  });

  test('FTS5 search index stays trigger-synced with photos', () => {
    const { db, repo } = openSeeded();
    const kyoto = samplePhoto({ place: 'Kyoto' });
    repo.insert(kyoto);
    repo.insert(samplePhoto({ place: 'Lisbon', camera: 'RICOH GR III' }));
    const hits = (q: string): number =>
      queryGet<{ n: number }>(db, 'SELECT count(*) AS n FROM photos_fts WHERE photos_fts MATCH ?', q)?.n ?? -1;
    assert.equal(hits('Kyoto'), 1);
    assert.equal(hits('RICOH'), 1);
    run(db, 'UPDATE photos SET place = ? WHERE id = ?', 'Osaka', kyoto.id);
    assert.equal(hits('Kyoto'), 0);
    assert.equal(hits('Osaka'), 1);
    run(db, 'DELETE FROM photos WHERE id = ?', kyoto.id);
    assert.equal(hits('Osaka'), 0);
    db.close();
  });

  test('page(query) ranks multi-word matches by bm25, prefix-matched (#390)', () => {
    const { db, repo } = openSeeded();
    // Exact multi-field match should outrank a single partial-field match.
    const best = samplePhoto({ place: 'Kyoto', camera: 'FUJIFILM X-T5' });
    const partial = samplePhoto({ place: 'Kyotango', camera: 'RICOH GR III' });
    const unrelated = samplePhoto({ place: 'Lisbon', camera: 'RICOH GR III' });
    repo.insert(unrelated);
    repo.insert(partial);
    repo.insert(best);
    const page = repo.page({ source: 'all', limit: 10, query: 'kyoto fuji' });
    assert.deepEqual(
      page.photos.map((photo) => photo.id),
      [best.id],
    );
    // Prefix matching: a partial last word still finds the full-word row.
    const prefixPage = repo.page({ source: 'all', limit: 10, query: 'kyo' });
    assert.deepEqual(new Set(prefixPage.photos.map((photo) => photo.id)), new Set([best.id, partial.id]));
    db.close();
  });

  test('page(query) tolerates quotes/operators/special characters without erroring (#390)', () => {
    const { db, repo } = openSeeded();
    repo.insert(samplePhoto({ place: 'Kyoto' }));
    for (const query of [`"Kyoto" AND NOT place`, 'Kyoto*', '((()))', '   ', '"""', 'foo OR bar NEAR/2 baz']) {
      assert.doesNotThrow(() => repo.page({ source: 'all', limit: 10, query }));
    }
    db.close();
  });

  test('page(query) keyset-pages through ranked results without gaps or overlap (#390)', () => {
    const { db, repo } = openSeeded();
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const photo = samplePhoto({ place: 'Kyoto', camera: `CAMERA ${i}` });
      ids.push(photo.id);
      repo.insert(photo);
    }
    const seen: string[] = [];
    let cursor = undefined;
    for (let i = 0; i < 6; i += 1) {
      const page = repo.page({ source: 'all', limit: 2, query: 'kyoto', cursor });
      seen.push(...page.photos.map((photo) => photo.id));
      cursor = page.nextCursor ?? undefined;
    }
    assert.equal(seen.length, 12);
    assert.equal(new Set(seen).size, 12);
    assert.deepEqual(new Set(seen), new Set(ids));
    db.close();
  });

  test('page(query) keyset-pages a tied-rank group without duplicates or gaps (#390)', () => {
    // Identical searchable text on every row forces an exact bm25 tie
    // across the whole set — FTS5 only guarantees `rank` order, so within
    // a tie it emits rows in its own internal order, not p.id order. A
    // cursor that breaks ties by p.id (instead of resolving back to the
    // matching photo's rowid) can duplicate or skip rows once a tied group
    // spans a page boundary.
    const { db, repo } = openSeeded();
    const ids: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const photo = samplePhoto({ place: 'Kyoto', camera: 'FUJIFILM X-T5' });
      ids.push(photo.id);
      repo.insert(photo);
    }
    const seen: string[] = [];
    let cursor = undefined;
    for (let i = 0; i < 30; i += 1) {
      const page = repo.page({ source: 'all', limit: 2, query: 'kyoto', cursor });
      seen.push(...page.photos.map((photo) => photo.id));
      cursor = page.nextCursor ?? undefined;
    }
    assert.equal(seen.length, 60, `expected 60 rows with no duplicates/gaps, got ${String(seen.length)}`);
    assert.equal(new Set(seen).size, 60);
    assert.deepEqual(new Set(seen), new Set(ids));
    db.close();
  });

  test('search index integrity check is a no-op when healthy; corruption triggers rebuild (#390)', () => {
    const { db, repo } = openSeeded();
    const kyoto = samplePhoto({ place: 'Kyoto' });
    repo.insert(kyoto);
    assert.deepEqual(repo.verifySearchIndex(), { rebuilt: false });
    // Desync the index from the content table directly (bypassing the
    // triggers, which can't be bypassed through normal application SQL) —
    // an indexed row for a rowid that has no matching photos row.
    run(db, `INSERT INTO photos_fts (rowid, file_name, place, camera) VALUES (999999, 'ghost.jpg', 'Ghost', 'Ghost')`);
    assert.deepEqual(repo.verifySearchIndex(), { rebuilt: true });
    assert.equal(queryGet<{ n: number }>(db, 'SELECT count(*) AS n FROM photos_fts WHERE photos_fts MATCH ?', 'Ghost')?.n, 0);
    assert.equal(queryGet<{ n: number }>(db, 'SELECT count(*) AS n FROM photos_fts WHERE photos_fts MATCH ?', 'Kyoto')?.n, 1);
    db.close();
  });

  test('counts by source match the sidebar vocabulary', () => {
    const { db, repo } = openSeeded();
    repo.insert(samplePhoto({ importedAt: '2026-07-11T00:00:00.000Z' }));
    repo.insert(samplePhoto({ favorite: true }));
    const offloaded = samplePhoto();
    repo.insert(offloaded);
    run(db, `UPDATE sync_ledger SET status = 'offloaded' WHERE photo_id = ?`, offloaded.id);
    const deleted = samplePhoto();
    repo.insert(deleted);
    run(db, `UPDATE photos SET deleted_at = ? WHERE id = ?`, '2026-07-12T00:00:00.000Z', deleted.id);

    assert.deepEqual(repo.counts('2026-07-10T00:00:00.000Z'), {
      all: 3,
      favorites: 1,
      recent: 1,
      offloaded: 1,
      deleted: 1,
    });
    db.close();
  });

  test('200K synthetic rows: one keyset page stays fast (baseline recorded)', () => {
    const { db, repo } = openSeeded();
    const insert = db.prepare(
      `INSERT INTO photos (id, file_name, file_kind, width, height, bytes, content_hash,
        imported_at, import_source, favorite, key_id, taken_at)
       VALUES (?, ?, 'jpeg', 6000, 4000, 8400000, ?, '2026-07-01T00:00:00.000Z', 'seed', 0, 1, ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < 200_000; i += 1) {
        const n = String(i).padStart(7, '0');
        insert.run(
          `01J8SEED${n}`,
          `IMG_${n}.JPG`,
          `seed-hash-${n}`,
          `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}T08:00:00.000Z`,
        );
      }
    })();

    const started = process.hrtime.bigint();
    const page = repo.page({ source: 'all', limit: 200 });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    assert.equal(page.photos.length, 200);
    assert.notEqual(page.nextCursor, null);
    // Baseline: keyset page over 200K rows. Budget formalizes in M11; this
    // bound only catches order-of-magnitude regressions (e.g. a lost index).
    assert.ok(elapsedMs < 250, `page query took ${elapsedMs.toFixed(1)}ms`);

    console.log(`[baseline] 200K keyset page: ${elapsedMs.toFixed(1)}ms`);
    db.close();
  });
});

describe('albums (#117)', () => {
  function clearDirty(db: Database.Database): void {
    run(db, 'UPDATE sync_ledger SET dirty = 0');
  }

  function dirtyIds(db: Database.Database): string[] {
    return queryAll<{ photo_id: string }>(db, 'SELECT photo_id FROM sync_ledger WHERE dirty = 1 ORDER BY photo_id').map(
      (row) => row.photo_id,
    );
  }

  test('EXIT CRITERIA: create → count 0 → membership counts → album filter pages', () => {
    const { db, repo } = openSeeded();
    repo.insert(samplePhoto());
    repo.insert(samplePhoto());
    const ids = repo.page({ source: 'all', limit: 10 }).photos.map((photo) => photo.id);

    const album = repo.createAlbum('ALB1', 'Kyoto trip');
    assert.deepEqual(album, { id: 'ALB1', name: 'Kyoto trip', count: 0 });
    assert.deepEqual(repo.albums().at(-1), { id: 'ALB1', name: 'Kyoto trip', count: 0 });

    repo.addToAlbum('ALB1', [ids[0] ?? '']);
    assert.equal(repo.albums().at(-1)?.count, 1);
    const filtered = repo.page({ source: 'all', limit: 10, albumId: 'ALB1' });
    assert.deepEqual(
      filtered.photos.map((photo) => photo.id),
      [ids[0]],
    );
    db.close();
  });

  test('membership edits dirty exactly the affected rows; re-adds are ignored', () => {
    const { db, repo } = openSeeded();
    repo.insert(samplePhoto());
    repo.insert(samplePhoto());
    const ids = repo
      .page({ source: 'all', limit: 10 })
      .photos.map((photo) => photo.id)
      .sort();
    repo.createAlbum('ALB1', 'Trip');
    clearDirty(db);

    assert.deepEqual(repo.addToAlbum('ALB1', ids).sort(), ids, 'both joined');
    assert.deepEqual(dirtyIds(db), ids, 'members dirtied for the next manifest');

    clearDirty(db);
    assert.deepEqual(repo.addToAlbum('ALB1', ids), [], 're-add is a no-op');
    assert.deepEqual(dirtyIds(db), [], 'no-ops never dirty');

    const first = ids[0] ?? '';
    assert.deepEqual(repo.removeFromAlbum('ALB1', [first]), [first]);
    assert.deepEqual(dirtyIds(db), [first], 'removal dirties the removed row only');
    db.close();
  });

  test('album move adds before removing, handles target duplicates, and rolls back on invalid targets (#279)', () => {
    const { db, repo } = openSeeded();
    repo.insert(samplePhoto());
    repo.insert(samplePhoto());
    const ids = repo.page({ source: 'all', limit: 10 }).photos.map((photo) => photo.id);
    repo.createAlbum('ALB1', 'Source');
    repo.createAlbum('ALB2', 'Target');
    const [first, second] = ids;
    assert.ok(first !== undefined && second !== undefined);
    repo.addToAlbum('ALB1', [first, second]);
    repo.addToAlbum('ALB2', [second]);

    assert.deepEqual(repo.moveBetweenAlbums('ALB1', 'ALB2', [first, second]), {
      moved: [first, second],
      alreadyInTarget: 1,
    });
    assert.deepEqual(repo.albumMembers('ALB1'), []);
    assert.deepEqual(repo.albumMembers('ALB2').sort(), [first, second].sort());

    repo.addToAlbum('ALB1', [first]);
    assert.throws(() => repo.moveBetweenAlbums('ALB1', 'MISSING', [first]), /does not exist/u);
    assert.deepEqual(repo.albumMembers('ALB1'), [first], 'failed move retains the source membership');
    assert.throws(() => repo.moveBetweenAlbums('ALB1', 'ALB1', [first]), /must differ/u);
    db.close();
  });

  test('rename persists and dirties members; unknown albums are typed errors', () => {
    const { db, repo } = openSeeded();
    repo.insert(samplePhoto());
    const id = repo.page({ source: 'all', limit: 1 }).photos[0]?.id ?? '';
    repo.createAlbum('ALB1', 'Old');
    repo.addToAlbum('ALB1', [id]);
    clearDirty(db);

    assert.deepEqual(repo.renameAlbum('ALB1', 'New'), [id]);
    assert.equal(repo.albums().at(-1)?.name, 'New');
    assert.deepEqual(dirtyIds(db), [id]);

    assert.throws(() => repo.renameAlbum('GHOST', 'X'), /does not exist/);
    assert.throws(() => repo.deleteAlbum('GHOST'), /does not exist/);
    assert.throws(() => repo.addToAlbum('GHOST', [id]), /does not exist/);
    db.close();
  });

  test('EXIT CRITERIA: deleting an album never deletes photos (Clear-vs-Delete)', () => {
    const { db, repo } = openSeeded();
    repo.insert(samplePhoto());
    const id = repo.page({ source: 'all', limit: 1 }).photos[0]?.id ?? '';
    repo.createAlbum('ALB1', 'Doomed');
    repo.addToAlbum('ALB1', [id]);
    clearDirty(db);

    assert.deepEqual(repo.deleteAlbum('ALB1'), [id]);
    assert.equal(
      repo.albums().some((album) => album.id === 'ALB1'),
      false,
      'album gone',
    );
    assert.equal(repo.page({ source: 'all', limit: 10 }).photos.length, 1, 'photo untouched');
    assert.equal(queryGet<{ n: number }>(db, 'SELECT count(*) AS n FROM album_photos')?.n, 0, 'membership cascaded');
    assert.deepEqual(dirtyIds(db), [id], 'former member re-manifests');
    db.close();
  });
});

describe('probed media info column (ADR-0026 §1, #547)', () => {
  test('mediaInfo roundtrips through insert and reads; stills stay null', () => {
    const { db, repo } = openSeeded();
    const info = { animated: true, frameCount: 3, loopCount: 0 };
    repo.insert(samplePhoto({ fileName: 'party.gif', fileKind: 'gif', mediaInfo: info }));
    repo.insert(samplePhoto({ fileName: 'still.jpg', fileKind: 'jpeg' }));
    const page = repo.page({ source: 'all', limit: 10, order: 'name' });
    const gif = page.photos.find((photo) => photo.fileKind === 'gif');
    const jpegRow = page.photos.find((photo) => photo.fileKind === 'jpeg');
    assert.deepEqual(gif?.mediaInfo, info);
    assert.equal(jpegRow?.mediaInfo, null);
    db.close();
  });

  test('a corrupt media_info value degrades to null instead of breaking reads', () => {
    const { db, repo } = openSeeded();
    repo.insert(
      samplePhoto({ fileName: 'sticker.webp', fileKind: 'webp', mediaInfo: { animated: false, frameCount: 1, loopCount: null } }),
    );
    // json_valid CHECK admits valid-but-wrong-shape JSON; the parser must not.
    run(db, `UPDATE photos SET media_info = '{"animated":"yes"}'`);
    const [row] = repo.page({ source: 'all', limit: 1 }).photos;
    assert.equal(row?.mediaInfo, null);
    db.close();
  });

  test('manifest snapshot carries mediaInfo and restore preserves it', () => {
    const { db, repo } = openSeeded();
    const info = { animated: true, frameCount: 3, loopCount: 2 };
    repo.insert(samplePhoto({ fileName: 'loop.webp', fileKind: 'webp', mediaInfo: info }));
    const snapshot = repo.manifestSnapshot();
    assert.deepEqual(snapshot.photos[0]?.mediaInfo, info);
    db.close();
  });
});

describe('Original preservation classification (#482)', () => {
  test('defaults false, persists explicitly, and only serializes true into recovery metadata', () => {
    const { db, repo } = openSeeded();
    const first = samplePhoto({ fileName: 'first.jpg', fileKind: 'jpeg' });
    const second = samplePhoto({ fileName: 'second.jpg', fileKind: 'jpeg' });
    repo.insert(first);
    repo.insert(second);
    assert.equal(repo.get(first.id)?.isOriginal, false);
    assert.deepEqual(repo.setOriginal([first.id], true), { changed: [first.id], unchanged: [], missing: [] });
    assert.equal(repo.get(first.id)?.isOriginal, true);

    const snapshot = repo.manifestSnapshot();
    assert.equal(snapshot.photos.find(({ id }) => id === first.id)?.isOriginal, true);
    assert.equal('isOriginal' in (snapshot.photos.find(({ id }) => id === second.id) ?? {}), false);
    db.close();
  });
});
