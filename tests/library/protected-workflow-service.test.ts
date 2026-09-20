import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import { DEFAULT_GALLERY_POLICY } from '../../src/shared/library/gallery-policy.js';
import { ActivityRepository } from '../../src/main/activity/activity-repository.js';
import { backupManifestV3Schema, buildBackupManifestV15 } from '../../src/main/backup/backup-manifest.js';
import { ProtectedRecoveryRepository } from '../../src/main/db/protected-recovery-repository.js';
import {
  moveCollection,
  setAlbumTags,
  setCollectionVisibility,
  readAlbumTree,
  deleteFolder,
  albumTreeSnapshot,
} from '../../src/main/db/album-tree-repository.js';
import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { ProtectedBlobStore } from '../../src/main/blobs/protected-blob-store.js';
import { ProtectedAlbumAuthorityRegistry } from '../../src/main/crypto/protected-album-authority.js';
import { ProtectedAlbumService } from '../../src/main/crypto/protected-album-service.js';
import { ProtectedPhotoMigrationService } from '../../src/main/crypto/protected-photo-migration-service.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { ProtectedAlbumRepository } from '../../src/main/db/protected-album-repository.js';
import { ProtectedPhotoMigrationRepository } from '../../src/main/db/protected-photo-migration-repository.js';
import { run } from '../../src/main/db/sql.js';
import { ProtectedWorkflowService, type ProtectedWorkflowProgress } from '../../src/main/library/protected-workflow-service.js';

const LIBRARY_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const PHOTO_ID = 'photo-private';
const PASSWORD = 'correct horse battery staple';

async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-protected-workflow-'));
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
  const ordinary = new BlobStore({ dataDir });
  const protectedBlobs = new ProtectedBlobStore(dataDir);
  await ordinary.init();
  await protectedBlobs.init();
  const libraryKey = randomBytes(32);
  const masterKey = randomBytes(32);
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped', '2026-07-16T12:00:00.000Z')`);
  const photos = new PhotosRepository(db);
  photos.createAlbum('ordinary-private', 'Private album');
  const original = Buffer.from('private workflow original');
  const contentHash = createHash('sha256').update(original).digest('hex');
  await ordinary.putOriginal(Readable.from(original), { id: 1, key: libraryKey }, PHOTO_ID);
  await ordinary.putThumb(Readable.from('small'), { id: 1, key: libraryKey }, PHOTO_ID, contentHash, 'thumb');
  await ordinary.putThumb(Readable.from('medium'), { id: 1, key: libraryKey }, PHOTO_ID, contentHash, 'mid');
  photos.insert({
    id: PHOTO_ID,
    fileName: 'private.jpg',
    fileKind: 'jpeg',
    width: 20,
    height: 10,
    bytes: original.length,
    contentHash,
    camera: 'private camera',
    lens: null,
    iso: 100,
    aperture: null,
    shutter: null,
    focalLength: null,
    takenAt: null,
    gpsLat: null,
    gpsLon: null,
    place: 'private place',
    importedAt: '2026-07-16T12:00:00.000Z',
    importSource: 'test',
    favorite: true,
    keyId: 1,
  });
  photos.addToAlbum('ordinary-private', [PHOTO_ID]);
  const authorities = new ProtectedAlbumAuthorityRegistry();
  const albumRecords = new ProtectedAlbumRepository(db, LIBRARY_ID);
  const albums = new ProtectedAlbumService({ libraryId: LIBRARY_ID, repository: albumRecords, authorities });
  let restorationIds = 0;
  const migrations = new ProtectedPhotoMigrationService({
    libraryId: LIBRARY_ID,
    ordinaryBlobs: ordinary,
    protectedBlobs,
    photos,
    migrations: new ProtectedPhotoMigrationRepository(db, undefined, {
      createId: () => `restoration-${++restorationIds}`,
      activity: new ActivityRepository(db),
    }),
    oweManifest: () => undefined,
  });
  const progress: ProtectedWorkflowProgress[] = [];
  let changes = 0;
  const ordinaryChanges: string[][] = [];
  let cancelOn: string | null = null;
  const workflow = new ProtectedWorkflowService({
    albums,
    albumRecords,
    authorities,
    migrations,
    photos,
    masterKey: () => Buffer.from(masterKey),
    resolveLibraryKey: () => (keyId) => (keyId === 1 ? libraryKey : undefined),
    currentLibraryKey: () => ({ id: 1, key: libraryKey }),
    progress: (value) => {
      progress.push(value);
      if (`${value.operation}:${value.stage}` === cancelOn) workflow.cancel();
    },
    changed: () => {
      changes += 1;
    },
    ordinaryChanged: (photoIds) => {
      ordinaryChanges.push([...photoIds]);
    },
    createId: () => 'protected-private',
  });
  return {
    db,
    ordinary,
    protectedBlobs,
    photos,
    albumRecords,
    albums,
    authorities,
    migrations,
    workflow,
    progress,
    original,
    contentHash,
    libraryKey,
    masterKey,
    changes: () => changes,
    ordinaryChanges,
    cancelOn: (stage: string | null) => {
      cancelOn = stage;
    },
  };
}

describe('ProtectedWorkflowService (#329)', () => {
  test('a sparse position after protection does not disqualify the saved folder', async () => {
    const value = await world();
    try {
      value.photos.createAlbum('folder', 'Folder', { kind: 'folder' });
      moveCollection(value.db, 'ordinary-private', 'folder');
      value.photos.createAlbum('after', 'After', { parentId: 'folder' });
      assert.deepEqual(await value.workflow.protect('ordinary-private', PASSWORD), { ok: true, albumId: 'protected-private' });
      assert.deepEqual(
        readAlbumTree(value.db).map(({ id, position }) => ({ id, position })),
        [
          { id: 'folder', position: 0 },
          { id: 'after', position: 2 },
        ],
        'the deleted source leaves the last sibling at the row count',
      );
      assert.deepEqual(await value.workflow.unprotect('protected-private', PASSWORD), { ok: true, albumId: 'protected-private' });
      const album = value.photos.albumForProtection('ordinary-private')!;
      assert.equal(album.organization.parentId, 'folder');
      assert.equal(album.organization.inheritsVisibility, true);
      assert.equal(album.organization.siblingPosition, 0);
      assert.deepEqual(
        readAlbumTree(value.db).map(({ id, position }) => ({ id, position })),
        [
          { id: 'folder', position: 0 },
          { id: 'ordinary-private', position: 1 },
          { id: 'after', position: 2 },
        ],
      );
      assert.equal(new ActivityRepository(value.db).page(20).events.length, 0, 'no false fallback activity');
    } finally {
      value.db.close();
    }
  });

  for (const parentState of ['present', 'deleted', 'not-folder', 'too-deep'] as const) {
    test(`restores organization with parent ${parentState} and preserves sealed backup metadata`, async () => {
      const value = await world();
      try {
        value.photos.createAlbum('folder', 'Folder', { kind: 'folder' });
        value.photos.createAlbum('before', 'Before', { parentId: 'folder' });
        moveCollection(value.db, 'ordinary-private', 'folder');
        value.photos.createAlbum('after', 'After', { parentId: 'folder' });
        value.photos.createAlbum('other-folder', 'Other folder', { kind: 'folder' });
        value.photos.createAlbum('unrelated', 'Unrelated', { parentId: 'other-folder' });
        setCollectionVisibility(value.db, 'folder', false);
        setCollectionVisibility(value.db, 'ordinary-private', 'inherit');
        setAlbumTags(value.db, 'ordinary-private', ['Travel', 'Family'], randomUUID);
        const organization = value.photos.albumForProtection('ordinary-private')!.organization;
        assert.equal(organization.siblingPosition, 1);
        assert.deepEqual(await value.workflow.protect('ordinary-private', PASSWORD), { ok: true, albumId: 'protected-private' });
        assert.equal(
          readAlbumTree(value.db).some((row) => row.id === 'ordinary-private'),
          false,
        );

        // The outer manifest carries opaque records. Parse and restore them in
        // a fresh database, then unlock through the real credential service.
        const snapshot = new ProtectedRecoveryRepository(value.db).snapshot();
        const manifest = backupManifestV3Schema.parse({
          schema: 3,
          libraryId: LIBRARY_ID,
          databaseSchema: 38,
          generatedAt: new Date().toISOString(),
          keyIds: [],
          totals: { photos: 0, bytes: 0, albums: 0 },
          photos: [],
          albums: [],
          ...snapshot,
        });
        const restoredDb = openLibraryDatabase({
          path: join(mkdtempSync(join(tmpdir(), 'overlook-protected-restored-')), 'library.db'),
          dbKey: randomBytes(32),
        });
        const restoredAuthorities = new ProtectedAlbumAuthorityRegistry();
        try {
          new ProtectedRecoveryRepository(restoredDb).restore(manifest);
          const restoredAlbums = new ProtectedAlbumService({
            libraryId: LIBRARY_ID,
            repository: new ProtectedAlbumRepository(restoredDb, LIBRARY_ID),
            authorities: restoredAuthorities,
          });
          const unlocked = await restoredAlbums.unlock('protected-private', PASSWORD);
          assert.equal(unlocked.ok, true);
          if (!unlocked.ok) throw new Error('restored credentials failed');
          assert.equal(unlocked.metadata.version, 2);
          assert.deepEqual(unlocked.metadata.version === 2 ? unlocked.metadata.ordinaryAlbum?.organization : undefined, organization);
          restoredAlbums.relock('protected-private');
        } finally {
          restoredDb.close();
        }

        if (parentState === 'deleted') deleteFolder(value.db, 'folder', { mode: 'move', destinationId: null });
        if (parentState === 'not-folder') {
          deleteFolder(value.db, 'folder', { mode: 'move', destinationId: null });
          value.photos.createAlbum('folder', 'Replacement album');
        }
        if (parentState === 'too-deep') {
          moveCollection(value.db, 'before', null);
          moveCollection(value.db, 'after', null);
          for (let depth = 0; depth < 6; depth += 1) {
            value.photos.createAlbum(`depth-${depth}`, `Depth ${depth}`, {
              kind: 'folder',
              parentId: depth === 0 ? null : `depth-${depth - 1}`,
            });
          }
          moveCollection(value.db, 'folder', 'depth-5');
        }
        if (parentState === 'present') setCollectionVisibility(value.db, 'folder', true);
        if (parentState === 'deleted') {
          run(
            value.db,
            "CREATE TRIGGER reject_restoration BEFORE INSERT ON photos BEGIN SELECT RAISE(ABORT, 'injected restoration failure'); END",
          );
          assert.deepEqual(await value.workflow.unprotect('protected-private', PASSWORD), { ok: false, reason: 'failed' });
          assert.equal(value.photos.albumForProtection('ordinary-private'), undefined, 'album insertion rolls back with photos');
          assert.equal(new ActivityRepository(value.db).page(20).events.length, 0, 'fallback note cannot outlive failed custody commit');
          run(value.db, 'DROP TRIGGER reject_restoration');
        }
        assert.deepEqual(await value.workflow.unprotect('protected-private', PASSWORD), { ok: true, albumId: 'protected-private' });
        const album = value.photos.albumForProtection('ordinary-private')!;
        assert.deepEqual(album.organization.tags, ['Family', 'Travel']);
        assert.equal(album.organization.inheritsVisibility, parentState === 'present');
        assert.equal(album.organization.parentId, parentState === 'present' ? 'folder' : null);
        assert.equal(album.showInAllPhotos, parentState === 'present');
        if (parentState === 'present') {
          assert.deepEqual(
            readAlbumTree(value.db)
              .filter((row) => row.parentId === 'folder')
              .map((row) => row.id),
            ['before', 'ordinary-private', 'after'],
          );
        }
        assert.deepEqual(
          readAlbumTree(value.db)
            .filter((row) => row.parentId === 'other-folder')
            .map((row) => row.id),
          ['unrelated'],
        );
        const notes = new ActivityRepository(value.db).page(20).events;
        assert.equal(notes.length, parentState === 'present' ? 0 : 1);
        if (parentState !== 'present') {
          assert.equal(notes[0]!.payload['reason'], 'protected-parent-unavailable');
          assert.match(notes[0]!.eventId, /^restoration-/u, 'uses the supplied ID generator');
        }
        assert.doesNotThrow(
          () =>
            buildBackupManifestV15({
              libraryId: LIBRARY_ID,
              generatedAt: new Date().toISOString(),
              snapshot: {
                ...value.photos.manifestSnapshot(),
                ...albumTreeSnapshot(value.db),
                protectedAlbums: [],
                protectedPhotos: [],
                activity: notes,
                boards: [],
                sidecars: [],
                galleryPolicy: DEFAULT_GALLERY_POLICY,
                hiddenAlbumIds: [],
                editRevisions: [],
                provenance: [],
                variantFamilies: [],
              },
            }),
          'restored tree must remain publishable by the current backup manifest',
        );
      } finally {
        value.db.close();
      }
    });
  }

  test('protects an ordinary album, restarts locked, and restores it without leaking an empty row', async () => {
    const value = await world();
    const protectedResult = await value.workflow.protect('ordinary-private', PASSWORD);
    assert.deepEqual(protectedResult, { ok: true, albumId: 'protected-private' });
    assert.equal(value.photos.albumForProtection('ordinary-private'), undefined);
    assert.equal(value.photos.get(PHOTO_ID), undefined);
    assert.equal(value.albumRecords.get('protected-private')?.migrationState, 'active');
    assert.deepEqual(
      value.progress.map(({ operation, stage }) => `${operation}:${stage}`),
      ['protect:preparing', 'protect:copying', 'protect:verifying', 'protect:committing', 'protect:purging', 'protect:complete'],
    );

    assert.deepEqual(await value.workflow.unlock('protected-private', PASSWORD), { ok: true, outcome: 'opened' });
    assert.deepEqual(await value.workflow.unprotect('protected-private', 'wrong password'), { ok: false, reason: 'wrong-password' });
    assert.deepEqual(await value.workflow.unprotect('protected-private', PASSWORD), { ok: true, albumId: 'protected-private' });
    assert.equal(value.albumRecords.get('protected-private'), undefined);
    assert.deepEqual(value.photos.albums(), [
      {
        id: 'ordinary-private',
        name: 'Private album',
        count: 1,
        showInAllPhotos: true,
        visibleElsewhere: 0,
        visibleVia: [],
        kind: 'album',
        parentId: null,
        inheritsVisibility: false,
        tags: [],
        predicate: null,
        unsupported: null,
      },
    ]);
    assert.equal(value.photos.get(PHOTO_ID)?.place, 'private place');
    assert.equal(
      await value.ordinary.verifyOriginal(value.contentHash, (keyId) => (keyId === 1 ? value.libraryKey : undefined), PHOTO_ID),
      true,
    );
    assert.equal(value.changes(), 3);
    assert.deepEqual(value.ordinaryChanges, [[PHOTO_ID], [PHOTO_ID]]);
    value.db.close();
  });

  test('a hidden album keeps its All Photos policy through protect and unprotect (#494)', async () => {
    const value = await world();
    value.photos.setAlbumVisibility('ordinary-private', false);
    assert.equal(value.photos.counts('2026-07-01T00:00:00.000Z').hiddenByAlbums, 1);
    assert.deepEqual(await value.workflow.protect('ordinary-private', PASSWORD), { ok: true, albumId: 'protected-private' });
    assert.deepEqual(await value.workflow.unlock('protected-private', PASSWORD), { ok: true, outcome: 'opened' });
    assert.deepEqual(await value.workflow.unprotect('protected-private', PASSWORD), { ok: true, albumId: 'protected-private' });
    assert.deepEqual(value.photos.albums(), [
      {
        id: 'ordinary-private',
        name: 'Private album',
        count: 1,
        showInAllPhotos: false,
        visibleElsewhere: 0,
        visibleVia: [],
        kind: 'album',
        parentId: null,
        inheritsVisibility: false,
        tags: [],
        predicate: null,
        unsupported: null,
      },
    ]);
    // The flag was recomputed inside the unprotect transaction, not left for startup.
    assert.equal(value.photos.counts('2026-07-01T00:00:00.000Z').hiddenByAlbums, 1);
    assert.equal(value.photos.page({ source: 'all', limit: 10 }).photos.length, 0);
    assert.equal(value.photos.page({ source: 'all', limit: 10, albumId: 'ordinary-private' }).photos.length, 1);
    value.db.close();
  });

  test('rejects missing and empty albums without creating protected custody', async () => {
    const value = await world();
    value.photos.createAlbum('empty', 'Empty');
    assert.deepEqual(await value.workflow.protect('missing', PASSWORD), { ok: false, reason: 'not-found' });
    assert.deepEqual(await value.workflow.protect('empty', PASSWORD), { ok: false, reason: 'empty' });
    assert.deepEqual(value.albumRecords.listOpaque(), []);
    value.db.close();
  });

  test('cancels only before commit and never exposes an empty restoration album', async () => {
    const beforeCommit = await world();
    beforeCommit.cancelOn('protect:copying');
    assert.deepEqual(await beforeCommit.workflow.protect('ordinary-private', PASSWORD), { ok: false, reason: 'cancelled' });
    assert.equal(beforeCommit.photos.albumForProtection('ordinary-private')?.photoIds.length, 1);
    assert.deepEqual(beforeCommit.albumRecords.listOpaque(), []);
    beforeCommit.db.close();

    const removal = await world();
    assert.equal((await removal.workflow.protect('ordinary-private', PASSWORD)).ok, true);
    removal.cancelOn('unprotect:verifying');
    assert.deepEqual(await removal.workflow.unprotect('protected-private', PASSWORD), { ok: false, reason: 'cancelled' });
    assert.equal(removal.photos.albumForProtection('ordinary-private'), undefined);
    assert.equal(removal.albumRecords.get('protected-private')?.migrationState, 'active');
    removal.cancelOn(null);
    assert.equal((await removal.workflow.unprotect('protected-private', PASSWORD)).ok, true);
    assert.equal(removal.photos.albumForProtection('ordinary-private')?.photoIds.length, 1);
    removal.db.close();
  });

  test('resumes a committed protection journal after restart authority is supplied', async () => {
    const value = await world();
    const source = value.photos.albumForProtection('ordinary-private');
    assert.ok(source);
    await value.albums.provision({
      albumId: 'protected-private',
      password: PASSWORD,
      masterKey: Buffer.from(value.masterKey),
      metadata: {
        version: 1,
        name: source.name,
        createdAt: source.createdAt,
        position: source.position,
        ordinaryAlbum: { id: source.id, createdAt: source.createdAt, position: source.position },
        members: source.photoIds.map((photoId, position) => ({ photoId, position, ordinaryMemberships: [] })),
      },
    });
    const albumKey = value.authorities.withAuthority('protected-private', (key) => Buffer.from(key));
    const migrationId = value.migrations.prepareProtect({ albumId: 'protected-private', albumKey, photoIds: source.photoIds });
    const authority = { targetAlbumKey: albumKey, libraryResolver: (keyId: number) => (keyId === 1 ? value.libraryKey : undefined) };
    await value.migrations.advance(migrationId, authority);
    await value.migrations.advance(migrationId, authority);
    await value.migrations.advance(migrationId, authority);
    albumKey.fill(0);
    value.albums.relock('protected-private');

    assert.deepEqual(await value.workflow.unlock('protected-private', PASSWORD), { ok: true, outcome: 'protection-completed' });
    assert.equal(value.albumRecords.get('protected-private')?.migrationState, 'active');
    assert.equal(value.photos.albumForProtection('ordinary-private'), undefined);
    assert.deepEqual(await value.workflow.unlock('protected-private', PASSWORD), { ok: true, outcome: 'opened' });
    value.db.close();
  });
});
