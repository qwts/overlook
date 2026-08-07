import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { buildBackupManifestV2 } from '../../src/main/backup/backup-manifest.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotoMetadataRepository } from '../../src/main/db/photo-metadata-repository.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

const DB_KEY = randomBytes(32);
const GENERATED_AT = '2026-08-07T18:00:00.000Z';

function path(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'library.db');
}

function photo(id: string, overrides: Partial<PhotoInsert> = {}): PhotoInsert {
  return {
    id,
    fileName: `${id}.jpg`,
    fileKind: 'jpeg',
    width: 1200,
    height: 800,
    bytes: 42,
    contentHash: (id === 'P1' ? 'a' : 'b').repeat(64),
    camera: 'Camera',
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focalLength: null,
    takenAt: null,
    gpsLat: null,
    gpsLon: null,
    place: null,
    importedAt: GENERATED_AT,
    importSource: 'test',
    keyId: 1,
    ...overrides,
  };
}

function openSeeded(dbPath = path('overlook-photo-metadata-')) {
  const db = openLibraryDatabase({ path: dbPath, dbKey: DB_KEY });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped', ?)`, GENERATED_AT);
  return { db, photos: new PhotosRepository(db), metadata: new PhotoMetadataRepository(db) };
}

describe('authored photo metadata (#508)', () => {
  test('normalizes bulk edits, retains imported provenance, updates search, and manages tags with exact counts', () => {
    const { db, photos, metadata } = openSeeded();
    photos.insert(photo('P1', { importedKeywords: ['Travel'], userTags: ['Family'] }));
    photos.insert(photo('P2', { importedKeywords: ['travel'], userTags: ['Portfolio'] }));

    assert.deepEqual(metadata.summary(['P1', 'P2', 'missing']), {
      found: 2,
      missing: 1,
      title: { mixed: false, value: null },
      description: { mixed: false, value: null },
      commonTags: ['Travel'],
      varyingTags: ['Family', 'Portfolio'],
    });

    const ledger = new SyncLedger(db);
    ledger.settleManifestOnly('P1');
    assert.equal(ledger.isDirty('P1'), false);
    assert.deepEqual(
      metadata.update({
        photoIds: ['P1', 'missing'],
        title: '  Ｌｉｓｂｏｎ  ',
        description: '  Waterfront walk  ',
        addTags: ['Night', 'night'],
        removeTags: ['travel'],
      }),
      { updated: 1, unchanged: 0, missing: 1, photoIds: ['P1'] },
    );
    assert.equal(ledger.isDirty('P1'), true);
    assert.deepEqual(photos.get('P1'), {
      ...photos.get('P1'),
      title: 'Lisbon',
      description: 'Waterfront walk',
      tags: ['Family', 'Night'],
      userTags: ['Family', 'Night'],
      importedKeywords: ['Travel'],
      suppressedKeywords: ['travel'],
      metadataVersion: 2,
    });
    assert.deepEqual(
      photos.page({ source: 'all', query: 'night', limit: 10 }).photos.map(({ id }) => id),
      ['P1'],
      'FTS reflects edits in the same transaction',
    );
    assert.deepEqual(
      photos.page({ source: 'all', query: 'travel', limit: 10 }).photos.map(({ id }) => id),
      ['P2'],
      'suppressed imported keywords no longer match',
    );

    assert.deepEqual(metadata.manage({ operation: 'rename', source: 'Family', target: 'Portfolio' }), {
      updated: 1,
      unchanged: 1,
      missing: 0,
      photoIds: ['P1'],
      merged: true,
    });
    assert.deepEqual(metadata.suggestions('port', 10), [{ name: 'Portfolio', count: 2 }]);
    db.close();
  });

  test('enforces the effective tag cap while imported projection remains tolerant', () => {
    const { db, photos, metadata } = openSeeded();
    const tags = Array.from({ length: 100 }, (_, index) => `tag-${String(index).padStart(3, '0')}`);
    photos.insert(photo('P1', { importedKeywords: tags }));
    photos.insert(photo('P2'));

    assert.throws(() => metadata.update({ photoIds: ['P1'], addTags: ['overflow'] }), /at most 100 effective tags/u);
    assert.equal(photos.get('P1')?.tags.length, 100);
    assert.equal(metadata.addImportedKeywords('P2', [...tags, 'overflow']), true);
    assert.equal(photos.get('P2')?.importedKeywords.length, 100);
    assert.equal(photos.get('P2')?.tags.length, 100);
    db.close();
  });

  test('excludes protected migration rows and preserves metadata through manifest restore', () => {
    const { db, photos, metadata } = openSeeded();
    photos.insert(
      photo('P1', {
        title: 'Original title',
        description: 'Catalog description',
        importedKeywords: ['Imported'],
        userTags: ['Authored'],
        suppressedKeywords: ['Imported'],
        metadataVersion: 7,
      }),
    );
    photos.insert(photo('P2', { userTags: ['Hidden'] }));
    run(
      db,
      `INSERT INTO protected_album_records (
         album_id, record_version, migration_state, credential_generation,
         metadata_generation, credential_record, sealed_metadata, created_at, updated_at
       ) VALUES ('A1', 1, 'active', 1, 1, X'00', X'00', ?, ?)`,
      GENERATED_AT,
      GENERATED_AT,
    );
    run(
      db,
      `INSERT INTO protected_photo_migrations (
         migration_id, operation, source_album_id, target_album_id, phase, created_at, updated_at
       ) VALUES ('M1', 'protect', NULL, 'A1', 'prepare', ?, ?)`,
      GENERATED_AT,
      GENERATED_AT,
    );
    run(
      db,
      `INSERT INTO protected_photo_migration_items (
         migration_id, photo_id, source_blob_ref, target_blob_ref, sealed_target_metadata,
         has_thumb, has_mid, item_phase
       ) VALUES ('M1', 'P2', ?, ?, X'00', 0, 0, 'prepare')`,
      'b'.repeat(64),
      'c'.repeat(64),
    );

    assert.deepEqual(metadata.update({ photoIds: ['P2'], title: 'Must stay isolated' }), {
      updated: 0,
      unchanged: 0,
      missing: 1,
      photoIds: [],
    });
    assert.deepEqual(metadata.suggestions('hidden', 10), [], 'protected tags never enter ordinary autocomplete');

    const manifest = buildBackupManifestV2({
      libraryId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      generatedAt: GENERATED_AT,
      snapshot: photos.manifestSnapshot(),
    });
    assert.deepEqual(manifest.photos[0], {
      ...manifest.photos[0],
      title: 'Original title',
      description: 'Catalog description',
      importedKeywords: ['Imported'],
      userTags: ['Authored'],
      suppressedKeywords: ['Imported'],
      metadataVersion: 7,
    });
    db.close();

    const restored = openLibraryDatabase({ path: path('overlook-photo-metadata-restored-'), dbKey: DB_KEY });
    const restoredPhotos = new PhotosRepository(restored);
    restoredPhotos.restoreManifest(manifest, [{ id: 1, wrappedKey: 'wrapped', createdAt: GENERATED_AT, status: 'active' }]);
    assert.deepEqual(restoredPhotos.get('P1')?.title, 'Original title');
    assert.deepEqual(restoredPhotos.get('P1')?.description, 'Catalog description');
    assert.deepEqual(restoredPhotos.get('P1')?.tags, ['Authored']);
    assert.deepEqual(restoredPhotos.get('P1')?.importedKeywords, ['Imported']);
    assert.deepEqual(restoredPhotos.get('P1')?.suppressedKeywords, ['Imported']);
    assert.deepEqual(restoredPhotos.get('P1')?.metadataVersion, 7);
    restored.close();
  });
});
