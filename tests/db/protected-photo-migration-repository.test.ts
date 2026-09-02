import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { EmbeddingRepository, EMBEDDING_DIMENSIONS } from '../../src/main/db/embedding-repository.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import {
  ProtectedPhotoMigrationRepository,
  ProtectedPhotoMigrationRepositoryError,
} from '../../src/main/db/protected-photo-migration-repository.js';
import { queryAll, run, runNamed } from '../../src/main/db/sql.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

function photo(id: string, contentHash = 'a'.repeat(64)): PhotoInsert {
  return {
    id,
    fileName: `${id}.jpg`,
    fileKind: 'jpeg',
    width: 10,
    height: 10,
    bytes: 4,
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
    importedAt: '2026-07-16T12:00:00.000Z',
    importSource: 'test',
    favorite: true,
    keyId: 1,
  };
}

function world(): {
  readonly db: ReturnType<typeof openLibraryDatabase>;
  readonly photos: PhotosRepository;
  readonly migrations: ProtectedPhotoMigrationRepository;
} {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-protected-journal-')), 'library.db'),
    dbKey: randomBytes(32),
  });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped', '2026-07-16T12:00:00.000Z')`);
  for (const albumId of ['protected-a', 'protected-b']) {
    runNamed(
      db,
      `INSERT INTO protected_album_records (
         album_id, record_version, migration_state, credential_generation, metadata_generation,
         credential_record, sealed_metadata, created_at, updated_at
       ) VALUES (@albumId, 1, 'active', 1, 1, x'01', x'02', @now, @now)`,
      { albumId, now: '2026-07-16T12:00:00.000Z' },
    );
  }
  return { db, photos: new PhotosRepository(db), migrations: new ProtectedPhotoMigrationRepository(db) };
}

const item = (photoId: string, sourceBlobRef = 'a'.repeat(64), targetBlobRef = 'b'.repeat(64)) => ({
  photoId,
  sourceBlobRef,
  targetBlobRef,
  sealedTargetMetadata: Buffer.from('sealed'),
  hasThumb: true,
  hasMid: true,
});

describe('ProtectedPhotoMigrationRepository', () => {
  test('prepare hides every ordinary query, dedupe, action, and diagnostic surface; rollback restores the source', () => {
    const { db, photos, migrations } = world();
    photos.createAlbum('ordinary-a', 'Ordinary');
    photos.insert(photo('photo-a'));
    runNamed(db, `UPDATE sync_ledger SET last_backup_at = @at, dirty = 0, status = 'synced' WHERE photo_id = @photoId`, {
      at: '2026-07-16T12:30:00.000Z',
      photoId: 'photo-a',
    });
    photos.addToAlbum('ordinary-a', ['photo-a']);
    const embeddings = new EmbeddingRepository(db);
    embeddings.put({ photoId: 'photo-a', contentHash: 'a'.repeat(64) }, 'fixture-model', new Int8Array(EMBEDDING_DIMENSIONS));
    migrations.prepare({
      migrationId: 'migration-a',
      operation: 'protect',
      sourceAlbumId: null,
      targetAlbumId: 'protected-a',
      items: [item('photo-a')],
    });
    assert.equal(embeddings.vectorCount(), 0, 'protect preparation removes the unlocked content fingerprint atomically');
    assert.equal(photos.get('photo-a'), undefined);
    assert.deepEqual(migrations.listProtected('protected-a'), []);
    for (const source of ['all', 'favorites', 'recent', 'offloaded', 'deleted'] as const) {
      assert.deepEqual(
        photos.page({ source, limit: 10, ...(source === 'recent' ? { recentSince: '2020-01-01T00:00:00.000Z' } : {}) }).photos,
        [],
        source,
      );
    }
    assert.deepEqual(photos.counts('2020-01-01T00:00:00.000Z'), {
      all: 0,
      favorites: 0,
      recent: 0,
      raw: 0,
      offloaded: 0,
      unavailable: 0,
      deleted: 0,
      excluded: 0,
      hiddenByAlbums: 0,
    });
    assert.deepEqual(photos.albums(), [
      {
        id: 'ordinary-a',
        name: 'Ordinary',
        count: 0,
        showInAllPhotos: true,
        visibleElsewhere: 0,
        visibleVia: [],
        kind: 'album',
        parentId: null,
        inheritsVisibility: false,
        tags: [],
      },
    ]);
    assert.deepEqual(photos.albumMembers('ordinary-a'), []);
    assert.equal(photos.stats().photos, 0);
    assert.equal(photos.stats().bytes, 0);
    assert.equal(photos.stats().lastBackupAt, null, 'ordinary status cannot reveal a protected backup timestamp');
    assert.equal(photos.hasContentHash('a'.repeat(64)), false, 'ordinary dedupe cannot reveal a protected match');
    assert.deepEqual(photos.softDelete(['photo-a']), { deleted: [], protected: [], missing: ['photo-a'] });
    assert.deepEqual(photos.restore(['photo-a']), []);
    assert.deepEqual(photos.addToAlbum('ordinary-a', ['photo-a']), []);
    assert.deepEqual(photos.removeFromAlbum('ordinary-a', ['photo-a']), []);
    assert.throws(() => photos.toggleFavorite('photo-a'), /does not exist/u);
    assert.deepEqual(photos.allRows(), [], 'diagnostics receive no hidden row or identifier');
    assert.deepEqual(photos.exportableIds(), [], 'ordinary Export All cannot enumerate protected content');
    assert.deepEqual(photos.migrationOwnedContentHashes(), ['a'.repeat(64)], 'orphan repair retains ownership without a row');
    assert.deepEqual(photos.dirtyPhotos(), []);
    assert.deepEqual(photos.integrityItems({ afterId: null, limit: 10 }), []);
    assert.deepEqual(photos.manifestSnapshot().photos, []);
    migrations.rollbackPrecommit('migration-a');
    assert.equal(photos.get('photo-a')?.fileName, 'photo-a.jpg');
    db.close();
  });

  test('commit atomically replaces the ordinary row and retains the journal until purge', () => {
    const { db, photos, migrations } = world();
    photos.insert(photo('photo-a'));
    migrations.prepare({
      migrationId: 'migration-a',
      operation: 'protect',
      sourceAlbumId: null,
      targetAlbumId: 'protected-a',
      items: [item('photo-a')],
    });
    migrations.transition('migration-a', 'prepare', 'copy');
    migrations.transition('migration-a', 'copy', 'verify');
    migrations.commitProtect('migration-a');
    assert.equal(photos.get('photo-a'), undefined);
    assert.equal(migrations.getProtected('photo-a')?.blobRef, 'b'.repeat(64));
    assert.equal(migrations.listProtected('protected-a').length, 0);
    assert.equal(migrations.get('migration-a')?.phase, 'commit');
    migrations.markPurging('migration-a');
    migrations.finish('migration-a');
    assert.equal(migrations.listProtected('protected-a').length, 1);
    assert.equal(migrations.get('migration-a'), undefined);
    db.close();
  });

  test('one photo cannot enter two migration journals or protected domains', () => {
    const { db, photos, migrations } = world();
    photos.insert(photo('photo-a'));
    migrations.prepare({
      migrationId: 'migration-a',
      operation: 'protect',
      sourceAlbumId: null,
      targetAlbumId: 'protected-a',
      items: [item('photo-a')],
    });
    assert.throws(
      () =>
        migrations.prepare({
          migrationId: 'migration-b',
          operation: 'protect',
          sourceAlbumId: null,
          targetAlbumId: 'protected-b',
          items: [item('photo-a', 'a'.repeat(64), 'c'.repeat(64))],
        }),
      /UNIQUE/,
    );
    assert.throws(() => migrations.commitProtect('migration-a'), ProtectedPhotoMigrationRepositoryError);
    db.close();
  });

  test('authorized unprotect restores metadata and memberships; move switches only the protected domain', () => {
    const { db, photos, migrations } = world();
    photos.createAlbum('ordinary-a', 'Ordinary');
    runNamed(
      db,
      `INSERT INTO protected_photo_records (
         photo_id, album_id, record_version, blob_ref, sealed_metadata,
         has_thumb, has_mid, created_at, updated_at
       ) VALUES (@photoId, 'protected-a', 1, @blobRef, x'01', 1, 1, @now, @now)`,
      { photoId: 'photo-a', blobRef: 'b'.repeat(64), now: '2026-07-16T12:00:00.000Z' },
    );
    migrations.prepare({
      migrationId: 'move-a',
      operation: 'move',
      sourceAlbumId: 'protected-a',
      targetAlbumId: 'protected-b',
      items: [item('photo-a', 'b'.repeat(64), 'c'.repeat(64))],
    });
    migrations.transition('move-a', 'prepare', 'copy');
    migrations.transition('move-a', 'copy', 'verify');
    migrations.commitMove('move-a');
    migrations.markPurging('move-a');
    migrations.finish('move-a');
    assert.equal(migrations.getProtected('photo-a')?.albumId, 'protected-b');

    migrations.prepare({
      migrationId: 'unprotect-a',
      operation: 'unprotect',
      sourceAlbumId: 'protected-b',
      targetAlbumId: null,
      items: [item('photo-a', 'c'.repeat(64), 'd'.repeat(64))],
    });
    migrations.transition('unprotect-a', 'prepare', 'copy');
    migrations.transition('unprotect-a', 'copy', 'verify');
    migrations.commitUnprotect(
      'unprotect-a',
      new Map([['photo-a', { photo: photo('photo-a', 'd'.repeat(64)), memberships: [{ albumId: 'ordinary-a', position: 7 }] }]]),
    );
    assert.equal(photos.get('photo-a'), undefined);
    assert.deepEqual(photos.albumMembers('ordinary-a'), []);
    migrations.markPurging('unprotect-a');
    migrations.finish('unprotect-a');
    assert.equal(photos.get('photo-a')?.favorite, true);
    assert.deepEqual(photos.albumMembers('ordinary-a'), ['photo-a']);
    assert.equal(migrations.getProtected('photo-a'), undefined);
    db.close();
  });

  test('unprotect recomputes the All Photos flag for photos restored into hidden albums (#494)', () => {
    const { db, photos, migrations } = world();
    photos.createAlbum('ordinary-hidden', 'Hidden');
    photos.setAlbumVisibility('ordinary-hidden', false);
    runNamed(
      db,
      `INSERT INTO protected_photo_records (
         photo_id, album_id, record_version, blob_ref, sealed_metadata,
         has_thumb, has_mid, created_at, updated_at
       ) VALUES (@photoId, 'protected-a', 1, @blobRef, x'01', 1, 1, @now, @now)`,
      { photoId: 'photo-h', blobRef: 'b'.repeat(64), now: '2026-07-16T12:00:00.000Z' },
    );
    migrations.prepare({
      migrationId: 'unprotect-h',
      operation: 'unprotect',
      sourceAlbumId: 'protected-a',
      targetAlbumId: null,
      items: [item('photo-h', 'b'.repeat(64), 'e'.repeat(64))],
    });
    migrations.transition('unprotect-h', 'prepare', 'copy');
    migrations.transition('unprotect-h', 'copy', 'verify');
    migrations.commitUnprotect(
      'unprotect-h',
      new Map([['photo-h', { photo: photo('photo-h', 'e'.repeat(64)), memberships: [{ albumId: 'ordinary-hidden', position: 0 }] }]]),
      { id: 'ordinary-restored', name: 'Restored', createdAt: '2026-07-16T12:00:00.000Z', position: 0, showInAllPhotos: false },
    );
    assert.deepEqual(
      queryAll<{ id: string; flag: number }>(db, `SELECT id, in_all_photos AS flag FROM photos WHERE id = 'photo-h'`),
      [{ id: 'photo-h', flag: 0 }],
      'the flag is written in the unprotect transaction',
    );
    assert.deepEqual(
      queryAll<{ id: string; show: number }>(db, `SELECT id, show_in_all_photos AS show FROM albums ORDER BY position`),
      [
        { id: 'ordinary-restored', show: 0 },
        { id: 'ordinary-hidden', show: 0 },
      ],
      'the restored album carries the policy it was protected with',
    );
    db.close();
  });
});
