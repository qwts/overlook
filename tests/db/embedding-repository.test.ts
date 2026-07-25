import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { EmbeddingRepository, EMBEDDING_DIMENSIONS } from '../../src/main/db/embedding-repository.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { queryGet, run } from '../../src/main/db/sql.js';
import { vectorExtensionPath } from '../../src/main/db/vector-extension.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

const DB_KEY = randomBytes(32);
const MODEL_VERSION = 'mobileclip-s2-test-v1';

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'overlook-embeddings-')), 'library.db');
}

function photo(id: string, contentHash: string): PhotoInsert {
  return {
    id,
    fileName: `${id}.jpg`,
    fileKind: 'jpeg',
    width: 640,
    height: 480,
    bytes: 1024,
    contentHash,
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
    importedAt: '2026-07-25T00:00:00.000Z',
    importSource: 'test',
    keyId: 1,
  };
}

function vector(fill: number): Int8Array {
  return new Int8Array(EMBEDDING_DIMENSIONS).fill(fill);
}

function openSeeded(path = tempDbPath()): {
  readonly path: string;
  readonly db: ReturnType<typeof openLibraryDatabase>;
  readonly photos: PhotosRepository;
  readonly embeddings: EmbeddingRepository;
} {
  const db = openLibraryDatabase({ path, dbKey: DB_KEY });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped-test-key', ?)`, new Date().toISOString());
  return { path, db, photos: new PhotosRepository(db), embeddings: new EmbeddingRepository(db) };
}

describe('sqlite-vec SQLCipher composition (#391)', () => {
  test('loads vec0 before migration and rewrites packaged extension paths', () => {
    const { db } = openSeeded();
    assert.equal(queryGet<{ version: string }>(db, 'SELECT vec_version() AS version')?.version, 'v0.1.9');
    assert.deepEqual(
      queryGet<{ sql: string }>(db, `SELECT sql FROM sqlite_master WHERE name = 'photo_embedding_vectors'`)?.sql.includes('vec0'),
      true,
    );
    assert.equal(
      vectorExtensionPath('/Applications/Overlook.app/Contents/Resources/app.asar/node_modules/sqlite-vec/vec0.dylib'),
      '/Applications/Overlook.app/Contents/Resources/app.asar.unpacked/node_modules/sqlite-vec/vec0.dylib',
    );
    db.close();
  });

  test('stores vectors in the encrypted library and rejects raw inspection', () => {
    const { path, db, photos, embeddings } = openSeeded();
    const contentHash = 'a'.repeat(64);
    photos.insert(photo('P-ENCRYPTED', contentHash));
    embeddings.put({ photoId: 'P-ENCRYPTED', contentHash }, MODEL_VERSION, vector(7));
    db.close();

    const raw = readFileSync(path);
    assert.equal(raw.includes(Buffer.from('SQLite format 3')), false);
    assert.equal(raw.includes(Buffer.from(contentHash)), false);
    assert.equal(raw.includes(Buffer.from(MODEL_VERSION)), false);
  });
});

describe('EmbeddingRepository', () => {
  test('the database is the resumable queue and completed rows are not repeated', () => {
    const { db, photos, embeddings } = openSeeded();
    const first = photo('P-FIRST', '1'.repeat(64));
    const second = photo('P-SECOND', '2'.repeat(64));
    photos.insert(first);
    photos.insert(second);

    assert.deepEqual(embeddings.status(MODEL_VERSION), { total: 2, completed: 0, pending: 2 });
    assert.deepEqual(
      embeddings.pending(MODEL_VERSION, 1),
      [{ photoId: first.id, contentHash: first.contentHash }],
      'candidate order is stable and bounded',
    );

    embeddings.put({ photoId: first.id, contentHash: first.contentHash }, MODEL_VERSION, vector(1), '2026-07-25T01:00:00.000Z');
    assert.deepEqual(embeddings.status(MODEL_VERSION), { total: 2, completed: 1, pending: 1 });
    assert.deepEqual(embeddings.pending(MODEL_VERSION, 10), [{ photoId: second.id, contentHash: second.contentHash }]);
    assert.equal(embeddings.vectorCount(), 1);
    db.close();
  });

  test('content changes requeue, replace atomically, and enforce 512 int8 dimensions', () => {
    const { db, photos, embeddings } = openSeeded();
    const originalHash = '3'.repeat(64);
    const changedHash = '4'.repeat(64);
    photos.insert(photo('P-EDITED', originalHash));
    embeddings.put({ photoId: 'P-EDITED', contentHash: originalHash }, MODEL_VERSION, vector(-2));

    run(db, 'UPDATE photos SET content_hash = ? WHERE id = ?', changedHash, 'P-EDITED');
    assert.deepEqual(embeddings.pending(MODEL_VERSION, 10), [{ photoId: 'P-EDITED', contentHash: changedHash }]);
    assert.equal(embeddings.deleteStale(MODEL_VERSION), 1);
    assert.equal(embeddings.vectorCount(), 0);

    assert.throws(
      () => embeddings.put({ photoId: 'P-EDITED', contentHash: changedHash }, MODEL_VERSION, new Int8Array(8)),
      /512 dimensions/,
    );
    embeddings.put({ photoId: 'P-EDITED', contentHash: changedHash }, MODEL_VERSION, vector(4));
    assert.deepEqual(embeddings.status(MODEL_VERSION), { total: 1, completed: 1, pending: 0 });
    db.close();
  });

  test('soft delete requeues nothing and permanent purge cascades vector removal', () => {
    const { db, photos, embeddings } = openSeeded();
    const contentHash = '5'.repeat(64);
    photos.insert(photo('P-PURGED', contentHash));
    embeddings.put({ photoId: 'P-PURGED', contentHash }, MODEL_VERSION, vector(5));

    photos.softDelete(['P-PURGED']);
    assert.deepEqual(embeddings.status(MODEL_VERSION), { total: 0, completed: 0, pending: 0 });
    assert.equal(embeddings.deleteStale(MODEL_VERSION), 1);
    assert.equal(embeddings.vectorCount(), 0);

    photos.restore(['P-PURGED']);
    embeddings.put({ photoId: 'P-PURGED', contentHash }, MODEL_VERSION, vector(6));
    photos.softDelete(['P-PURGED']);
    photos.purgeRow('P-PURGED');
    assert.equal(embeddings.vectorCount(), 0, 'photo FK cascade fires the vec0 cleanup trigger');
    db.close();
  });

  test('protected/ineligible photos cannot be written through a stale candidate', () => {
    const { db, photos, embeddings } = openSeeded();
    const contentHash = '6'.repeat(64);
    photos.insert(photo('P-HIDDEN', contentHash));
    photos.softDelete(['P-HIDDEN']);

    assert.throws(() => embeddings.put({ photoId: 'P-HIDDEN', contentHash }, MODEL_VERSION, vector(1)), /not eligible/);
    assert.equal(embeddings.vectorCount(), 0);
    db.close();
  });
});
