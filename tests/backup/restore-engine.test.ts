import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';

import {
  backupManifestV3Schema,
  backupManifestV4Schema,
  backupManifestV5Schema,
  backupManifestV6Schema,
  buildBackupManifestV2,
  buildBackupManifestV4,
  type BackupManifestPhotoV2,
  type BackupManifestV2,
} from '../../src/main/backup/backup-manifest.js';
import { FaultInjectingProvider, MockProvider } from '../../src/main/backup/mock-provider.js';
import type { ProviderAuthState, ProviderQuota, RemoteEntry, StorageProvider } from '../../src/main/backup/provider.js';
import { sealRecoveryBootstrap } from '../../src/main/backup/recovery-bootstrap.js';
import { RestoreEngine, type RestoreEngineDeps } from '../../src/main/backup/restore-engine.js';
import { RestoreError, type RestoreProgress } from '../../src/main/backup/restore-types.js';
import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { ProtectedBlobStore } from '../../src/main/blobs/protected-blob-store.js';
import { createEncryptStream } from '../../src/main/crypto/envelope.js';
import { KeyStore, type SafeStorageLike } from '../../src/main/crypto/keystore.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { ProtectedRecoveryRepository } from '../../src/main/db/protected-recovery-repository.js';
import { ActivityRepository } from '../../src/main/activity/activity-repository.js';
import { queryGet } from '../../src/main/db/sql.js';
import { sampleJpeg } from '../../src/main/library/seed.js';

const LIBRARY_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const GENERATED_AT = '2026-07-14T23:00:00.000Z';

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => value.toString('utf8'),
};

class CountingProvider implements StorageProvider {
  readonly capabilities;
  readonly id: string;
  readonly label: string;
  readonly gets: string[] = [];

  constructor(private readonly inner: StorageProvider) {
    this.capabilities = inner.capabilities;
    this.id = inner.id;
    this.label = inner.label;
  }

  listLibraries(): Promise<readonly string[]> {
    return this.inner.listLibraries();
  }

  forLibrary(libraryId: string): StorageProvider {
    return new CountingProvider(this.inner.forLibrary(libraryId));
  }

  authState(): Promise<ProviderAuthState> {
    return this.inner.authState();
  }

  accountIdentity(signal?: AbortSignal) {
    return this.inner.accountIdentity(signal);
  }

  put(path: string, bytes: Readable): Promise<{ bytes: number }> {
    return this.inner.put(path, bytes);
  }

  getStream(path: string): Promise<Readable> {
    this.gets.push(path);
    return this.inner.getStream(path);
  }

  probe(path: string, signal?: AbortSignal): Promise<{ bytes: number }> {
    return this.inner.probe(path, signal);
  }

  list(prefix: string): Promise<readonly RemoteEntry[]> {
    return this.inner.list(prefix);
  }

  delete(path: string): Promise<void> {
    return this.inner.delete(path);
  }

  quota(): Promise<ProviderQuota> {
    return this.inner.quota();
  }

  verify(path: string): Promise<{ sha256: string; bytes: number }> {
    return this.inner.verify(path);
  }
}

interface RestoreWorld {
  readonly provider: MockProvider;
  readonly counting: CountingProvider;
  readonly keyStore: KeyStore;
  readonly masterKey: Buffer;
  readonly targetDir: string;
  readonly photos: readonly BackupManifestPhotoV2[];
  readonly plaintextById: ReadonlyMap<string, Buffer>;
  readonly progress: RestoreProgress[];
  readonly deps: RestoreEngineDeps;
}

async function put(provider: StorageProvider, path: string, bytes: Buffer): Promise<void> {
  await provider.put(path, Readable.from([bytes]));
}

async function sealManifest(value: unknown, keyStore: KeyStore): Promise<Buffer> {
  return buffer(
    Readable.from([Buffer.from(JSON.stringify(value))]).pipe(createEncryptStream(keyStore.currentKey(), { photoId: 'manifest' })),
  );
}

function makeManifest(photos: readonly BackupManifestPhotoV2[]): BackupManifestV2 {
  return buildBackupManifestV2({
    libraryId: LIBRARY_ID,
    generatedAt: GENERATED_AT,
    snapshot: {
      databaseSchema: 3,
      keyIds: [1],
      totals: { photos: photos.length, bytes: photos.reduce((sum, photo) => sum + photo.bytes, 0), albums: 1 },
      photos,
      albums: [
        {
          id: 'A1',
          name: 'Recovered',
          createdAt: GENERATED_AT,
          position: 0,
          photoIds: photos.map((photo) => photo.id),
        },
      ],
    },
  });
}

async function restoreWorld(count = 1, bootstrapVersion: 1 | 2 = 1): Promise<RestoreWorld> {
  const sourceDir = mkdtempSync(join(tmpdir(), 'overlook-restore-source-'));
  const targetDir = join(mkdtempSync(join(tmpdir(), 'overlook-restore-target-')), 'library');
  const keyStore = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: sourceDir });
  const masterKey = keyStore.masterKeyBytes();
  const sourceStore = new BlobStore({ dataDir: sourceDir });
  await sourceStore.init();
  const plaintextById = new Map<string, Buffer>();
  const photos: BackupManifestPhotoV2[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `P${String(index + 1)}`;
    const bytes = sampleJpeg(index + 1);
    plaintextById.set(id, bytes);
    const ref = await sourceStore.putOriginal(Readable.from([bytes]), keyStore.currentKey(), id);
    photos.push({
      id,
      fileName: `IMG_${String(index + 1)}.JPG`,
      fileKind: 'jpeg',
      mediaInfo: null,
      width: 1,
      height: 1,
      bytes: ref.bytes,
      contentHash: ref.contentHash,
      blobPath: `blobs/${ref.contentHash.slice(0, 2)}/${ref.contentHash}`,
      camera: 'Recovered Camera',
      lens: null,
      iso: 100,
      aperture: null,
      shutter: null,
      focalLength: null,
      takenAt: null,
      gpsLat: null,
      gpsLon: null,
      place: null,
      importedAt: `2026-07-14T23:00:0${String(index)}.000Z`,
      importSource: 'cloud-restore',
      favorite: index === 0,
      keyId: ref.keyId,
      deletedAt: null,
    });
  }
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-restore-remote-')), libraryId: LIBRARY_ID });
  for (const photo of photos) await put(provider, photo.blobPath, await buffer(sourceStore.getEncryptedStream(photo.contentHash)));
  const sealedManifest = await sealManifest(makeManifest(photos), keyStore);
  await put(
    provider,
    'recovery/bootstrap.ovrb',
    sealRecoveryBootstrap(
      bootstrapVersion === 1
        ? { schema: 1, libraryId: LIBRARY_ID, generatedAt: GENERATED_AT, keys: keyStore.exportWrappedKeys() }
        : {
            schema: 2,
            libraryId: LIBRARY_ID,
            generatedAt: GENERATED_AT,
            manifestGeneration: 1,
            manifestSha256: createHash('sha256').update(sealedManifest).digest('hex'),
            previousManifest: null,
            keys: keyStore.exportWrappedKeys(),
          },
      masterKey,
    ),
  );
  await put(provider, 'manifest/gen-1.ovlk', sealedManifest);
  const counting = new CountingProvider(provider);
  const progress: RestoreProgress[] = [];
  const deps: RestoreEngineDeps = {
    provider: counting,
    targetDir,
    safeStorage: fakeSafeStorage,
    availableBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    thumbnails: (store) => ({
      generateFor: async (request) => {
        await store.putThumb(
          Readable.from([Buffer.from(`thumb:${request.photoId}`)]),
          request.key,
          request.photoId,
          request.contentHash,
          'thumb',
        );
        await store.putThumb(
          Readable.from([Buffer.from(`mid:${request.photoId}`)]),
          request.key,
          request.photoId,
          request.contentHash,
          'mid',
        );
        return { generated: true, width: 1, height: 1 };
      },
    }),
    events: { progress: (value) => progress.push(value) },
  };
  return { provider, counting, keyStore, masterKey, targetDir, photos, plaintextById, progress, deps };
}

function isReason(reason: RestoreError['reason']): (error: unknown) => boolean {
  return (error) => error instanceof RestoreError && error.reason === reason;
}

test('restore engine: fresh staging rebuilds keys, catalog, originals, thumbnails, and albums before activation (#288)', async () => {
  const world = await restoreWorld(2);
  const result = await new RestoreEngine(world.deps).run({ masterKey: world.masterKey, allowReplace: false });
  assert.deepEqual(result, { libraryId: LIBRARY_ID, generation: 1, photos: 2, resumed: false, missing: [] });
  assert.equal(existsSync(`${world.targetDir}.restore-staging`), false);
  assert.equal(existsSync(`${world.targetDir}.restore-previous`), false);
  assert.equal((await readFile(join(world.targetDir, 'library-id'), 'utf8')).trim(), LIBRARY_ID);

  const restoredKeys = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: world.targetDir });
  const restoredHighWater = BigInt(restoredKeys.exportWrappedKeys().find((key) => key.status === 'active')?.nonceHighWater ?? '0');
  assert.equal(restoredKeys.currentKey().id, 2, 'freshness-unproven v1 active key is retired before restored writes');
  assert.ok(restoredHighWater > 0n, 'the fresh write key durably reserves thumbnail nonce prefixes');
  const dbKey = restoredKeys.resolver()(1);
  assert.ok(dbKey !== undefined);
  const db = openLibraryDatabase({ path: join(world.targetDir, 'library.db'), dbKey });
  const repo = new PhotosRepository(db);
  assert.deepEqual(repo.albums(), [{ id: 'A1', name: 'Recovered', count: 2 }]);
  assert.equal(repo.pendingCount(), 0);
  assert.equal(queryGet<{ count: number }>(db, 'SELECT count(*) AS count FROM photos_fts')?.count, 2);
  assert.equal(queryGet<{ count: number }>(db, 'SELECT count(*) AS count FROM keys')?.count, 2, 'the rotated key seeds the catalog');
  db.close();

  const restoredStore = new BlobStore({ dataDir: world.targetDir });
  await restoredStore.init();
  for (const photo of world.photos) {
    assert.deepEqual(
      await buffer(restoredStore.getStream(photo.contentHash, restoredKeys.resolver(), photo.id)),
      world.plaintextById.get(photo.id),
    );
    assert.equal(await restoredStore.verifyThumbs(photo.contentHash, restoredKeys.resolver(), photo.id), true);
  }
  assert.equal(world.progress.at(-1)?.stage, 'complete');
});

test('restore engine: a generation-bound v2 bootstrap keeps its active key and advances nonce state (#996)', async () => {
  const world = await restoreWorld(1, 2);
  const sourceHighWater = BigInt(world.keyStore.exportWrappedKeys()[0]?.nonceHighWater ?? '0');
  await new RestoreEngine(world.deps).run({ masterKey: world.masterKey, allowReplace: false });

  const restored = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: world.targetDir });
  assert.equal(restored.currentKey().id, 1);
  assert.equal(restored.exportWrappedKeys().length, 1);
  assert.ok(BigInt(restored.exportWrappedKeys()[0]?.nonceHighWater ?? '0') > sourceHighWater);
});

test('restore engine: bootstrap-first fallback rotates a fresh write key exactly once (#996)', async () => {
  const world = await restoreWorld(1, 2);
  const first = await buffer(await world.provider.getStream('manifest/gen-1.ovlk'));
  await put(
    world.provider,
    'recovery/bootstrap.ovrb',
    sealRecoveryBootstrap(
      {
        schema: 2,
        libraryId: LIBRARY_ID,
        generatedAt: GENERATED_AT,
        manifestGeneration: 2,
        manifestSha256: 'ab'.repeat(32),
        previousManifest: { generation: 1, sha256: createHash('sha256').update(first).digest('hex') },
        keys: world.keyStore.exportWrappedKeys(),
      },
      world.masterKey,
    ),
  );

  const result = await new RestoreEngine(world.deps).run({ masterKey: world.masterKey, allowReplace: false });
  assert.deepEqual(result, {
    libraryId: LIBRARY_ID,
    generation: 1,
    photos: 1,
    resumed: false,
    missing: [],
  });
  const restored = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: world.targetDir });
  assert.equal(restored.currentKey().id, 2);
});

test('restore engine: resumed v1 staging rotates exactly once after an interrupted thumbnail write (#996)', async () => {
  const world = await restoreWorld();
  const originalThumbnails = world.deps.thumbnails;
  let interrupt = true;
  const deps: RestoreEngineDeps = {
    ...world.deps,
    thumbnails: (store) => {
      const service = originalThumbnails(store);
      return {
        generateFor: (request) => (interrupt ? Promise.reject(new Error('interrupt after legacy rotation')) : service.generateFor(request)),
      };
    },
  };

  await assert.rejects(new RestoreEngine(deps).run({ masterKey: world.masterKey, allowReplace: false }), /interrupt/u);
  const stagingKeys = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: `${world.targetDir}.restore-staging` });
  assert.equal(stagingKeys.currentKey().id, 2);
  stagingKeys.close();

  interrupt = false;
  await new RestoreEngine(deps).run({ masterKey: world.masterKey, allowReplace: false });
  const restored = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: world.targetDir });
  assert.equal(restored.currentKey().id, 2, 'resume reuses the staged rotation instead of minting key 3');
});

test('restore engine: schema 4 restores protected ciphertext and encrypted activity history (#328/#614)', async () => {
  const world = await restoreWorld();
  const protectedSource = new ProtectedBlobStore(mkdtempSync(join(tmpdir(), 'overlook-protected-restore-source-')));
  await protectedSource.init();
  const albumId = 'protected-album';
  const photoId = 'protected-photo';
  const albumKey = randomBytes(32);
  const plaintext = Buffer.from('protected restore original');
  const contentHash = createHash('sha256').update(plaintext).digest('hex');
  const blobRef = await protectedSource.putOriginal({ albumId, albumKey, contentHash, plaintext: Readable.from(plaintext) });
  const ciphertext = await buffer(protectedSource.getEncryptedStream(albumId, blobRef, 'original'));
  const sha256 = createHash('sha256').update(ciphertext).digest('hex');
  const path = `protected/${blobRef.slice(0, 2)}/${blobRef}.original`;
  await put(world.provider, path, ciphertext);
  const ordinary = makeManifest(world.photos);
  const credentialRecord = Buffer.from('sealed credential record').toString('base64');
  const sealedAlbum = Buffer.from('sealed album metadata').toString('base64');
  const sealedPhoto = Buffer.from('sealed photo metadata').toString('base64');
  const manifest = buildBackupManifestV4({
    libraryId: LIBRARY_ID,
    generatedAt: GENERATED_AT,
    snapshot: {
      databaseSchema: 10,
      keyIds: ordinary.keyIds,
      totals: ordinary.totals,
      photos: ordinary.photos,
      albums: ordinary.albums,
      protectedAlbums: [
        {
          id: albumId,
          credentialGeneration: 1,
          metadataGeneration: 1,
          credentialRecord,
          sealedMetadata: sealedAlbum,
          createdAt: GENERATED_AT,
          updatedAt: GENERATED_AT,
        },
      ],
      protectedPhotos: [
        {
          id: photoId,
          albumId,
          blobRef,
          sealedMetadata: sealedPhoto,
          createdAt: GENERATED_AT,
          updatedAt: GENERATED_AT,
          objects: [{ kind: 'original', path, sha256, bytes: ciphertext.length, status: 'synced' }],
        },
      ],
      activity: [
        {
          sequence: 1,
          eventId: 'activity-event-1',
          operationId: 'activity-operation-1',
          eventType: 'import.completed',
          schemaVersion: 1,
          occurredAt: GENERATED_AT,
          actorClass: 'local-user',
          rootCorrelationId: 'activity-operation-1',
          causationEventId: null,
          entityIds: [],
          outcome: 'succeeded',
          payload: { imported: 1, mode: 'copy' },
          supersedesEventId: null,
        },
      ],
    },
  });
  await put(world.provider, 'manifest/gen-2.ovlk', await sealManifest(manifest, world.keyStore));

  const result = await new RestoreEngine(world.deps).run({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(result.generation, 2);
  const restoredKeys = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: world.targetDir });
  const dbKey = restoredKeys.resolver()(1);
  assert.ok(dbKey !== undefined);
  const db = openLibraryDatabase({ path: join(world.targetDir, 'library.db'), dbKey });
  const snapshot = new ProtectedRecoveryRepository(db).snapshot();
  assert.deepEqual(snapshot.protectedAlbums, manifest.protectedAlbums);
  assert.deepEqual(snapshot.protectedPhotos, manifest.protectedPhotos);
  assert.deepEqual(new ActivityRepository(db).backupSnapshot(), manifest.activity);
  db.close();
  const restored = new ProtectedBlobStore(world.targetDir);
  await restored.init();
  assert.deepEqual(await restored.ciphertextInfo(albumId, blobRef, 'original'), { sha256, bytes: ciphertext.length });
});

test('restore engine: corrupt newest-generation blob falls back without contaminating the previous generation (#288)', async () => {
  const world = await restoreWorld();
  const badHash = 'cd'.repeat(32);
  const first = world.photos[0];
  assert.ok(first !== undefined);
  const newestPhoto: BackupManifestPhotoV2 = { ...first, id: 'P-new', contentHash: badHash, blobPath: `blobs/cd/${badHash}` };
  await put(world.provider, newestPhoto.blobPath, Buffer.from('not an envelope'));
  await put(world.provider, 'manifest/gen-2.ovlk', await sealManifest(makeManifest([newestPhoto]), world.keyStore));

  const result = await new RestoreEngine(world.deps).run({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(result.generation, 1);
  const restoredKeys = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: world.targetDir });
  const restoredStore = new BlobStore({ dataDir: world.targetDir });
  await restoredStore.init();
  const original = world.photos[0];
  assert.ok(original !== undefined);
  assert.equal(await restoredStore.verifyOriginal(original.contentHash, restoredKeys.resolver(), original.id), true);
  assert.equal(restoredStore.hasOriginal(badHash), false);
});

test('restore engine: a generation referencing a MISSING blob is rejected and falls back to the complete retained generation (#741)', async () => {
  // The provider-switch incident shape: the newest generation promises a
  // blob the provider never held. Restore must not "fix" this by ignoring
  // the missing blob — it rejects the generation and restores the complete
  // retained one.
  const world = await restoreWorld();
  const missingHash = 'a3'.repeat(32);
  const first = world.photos[0];
  assert.ok(first !== undefined);
  const newestPhoto: BackupManifestPhotoV2 = { ...first, id: 'P-new', contentHash: missingHash, blobPath: `blobs/a3/${missingHash}` };
  await put(world.provider, 'manifest/gen-2.ovlk', await sealManifest(makeManifest([newestPhoto]), world.keyStore));

  const result = await new RestoreEngine(world.deps).run({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(result.generation, 1, 'restore fell back to the complete retained generation');
  const restoredKeys = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: world.targetDir });
  const restoredStore = new BlobStore({ dataDir: world.targetDir });
  await restoredStore.init();
  const original = world.photos[0];
  assert.ok(original !== undefined);
  assert.equal(await restoredStore.verifyOriginal(original.contentHash, restoredKeys.resolver(), original.id), true);
});

test('restore engine: cancellation checkpoints blobs and resumes without redownloading (#288)', async () => {
  const world = await restoreWorld(2);
  const controller = new AbortController();
  const cancelDeps: RestoreEngineDeps = {
    ...world.deps,
    events: {
      progress: (value) => {
        world.progress.push(value);
        if (value.stage === 'downloading' && value.done === 1) controller.abort();
      },
    },
  };
  await assert.rejects(
    new RestoreEngine(cancelDeps).run({ masterKey: world.masterKey, allowReplace: false, signal: controller.signal }),
    isReason('cancelled'),
  );
  const result = await new RestoreEngine(world.deps).run({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(result.resumed, true);
  for (const photo of world.photos) {
    assert.equal(
      world.counting.gets.filter((path) => path === photo.blobPath).length,
      1,
      `${photo.id} ciphertext should download exactly once`,
    );
  }
});

test('restore engine: non-empty targets require destructive authorization before remote reads (#288)', async () => {
  const world = await restoreWorld();
  mkdirSync(world.targetDir);
  writeFileSync(join(world.targetDir, 'existing'), 'keep me', { flag: 'wx' });
  const before = world.counting.gets.length;
  await assert.rejects(
    new RestoreEngine(world.deps).run({ masterKey: world.masterKey, allowReplace: false }),
    isReason('destructive-authorization'),
  );
  assert.equal(world.counting.gets.length, before);
  assert.equal(await readFile(join(world.targetDir, 'existing'), 'utf8'), 'keep me');
});

test('restore engine: disk preflight fails before downloading any referenced blob (#288)', async () => {
  const world = await restoreWorld();
  const noSpaceDeps: RestoreEngineDeps = { ...world.deps, availableBytes: () => Promise.resolve(0) };
  await assert.rejects(new RestoreEngine(noSpaceDeps).run({ masterKey: world.masterKey, allowReplace: false }), isReason('disk-space'));
  assert.equal(world.counting.gets.filter((path) => path.startsWith('blobs/')).length, 0);
  assert.equal(existsSync(world.targetDir), false);
});

test('restore engine: explicit authorization atomically replaces a non-empty library (#288)', async () => {
  const world = await restoreWorld();
  mkdirSync(world.targetDir);
  writeFileSync(join(world.targetDir, 'existing'), 'replace me');
  await new RestoreEngine(world.deps).run({ masterKey: world.masterKey, allowReplace: true });
  assert.equal(existsSync(join(world.targetDir, 'existing')), false);
  assert.equal(existsSync(join(world.targetDir, 'library.db')), true);
  assert.equal(existsSync(`${world.targetDir}.restore-previous`), false);
});

test('restore engine: provider authentication and offline failures retain typed reasons (#288)', async () => {
  const authWorld = await restoreWorld();
  authWorld.provider.setConnected(false);
  await assert.rejects(new RestoreEngine(authWorld.deps).run({ masterKey: authWorld.masterKey, allowReplace: false }), isReason('auth'));

  const offlineWorld = await restoreWorld();
  const faulty = new FaultInjectingProvider(offlineWorld.counting);
  faulty.arm('transient-get');
  const offlineDeps: RestoreEngineDeps = { ...offlineWorld.deps, provider: faulty };
  await assert.rejects(new RestoreEngine(offlineDeps).run({ masterKey: offlineWorld.masterKey, allowReplace: false }), isReason('offline'));
});

test('restore engine: activation reconciles the app-lock anchor exactly once; failures never touch it (#753)', async () => {
  const world = await restoreWorld();
  let resets = 0;
  const result = await new RestoreEngine({ ...world.deps, resetLockAnchor: () => (resets += 1) }).run({
    masterKey: world.masterKey,
    allowReplace: false,
  });
  assert.equal(result.photos, 1);
  assert.equal(resets, 1, 'the stale anchor cleared as part of activation');

  // A failure before activation must not touch the anchor. A missing blob no
  // longer qualifies (#915 partial-restores it), so fail the transport instead.
  const broken = await restoreWorld();
  const faulty = new FaultInjectingProvider(broken.counting);
  faulty.arm('transient-get');
  let brokenResets = 0;
  await assert.rejects(
    new RestoreEngine({ ...broken.deps, provider: faulty, resetLockAnchor: () => (brokenResets += 1) }).run({
      masterKey: broken.masterKey,
      allowReplace: false,
    }),
  );
  assert.equal(brokenResets, 0, 'a restore that never activated must not touch the anchor');
});

test('restore engine: an anchor-reset failure never undoes a completed activation (#753)', async () => {
  const world = await restoreWorld();
  const result = await new RestoreEngine({
    ...world.deps,
    resetLockAnchor: () => {
      throw new Error('keychain unavailable');
    },
  }).run({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(result.photos, 1, 'the restore result stands');
});

test('restore engine: fresh custody authority re-establishes the app-lock record only after activation (#754)', async () => {
  const world = await restoreWorld();
  const calls: { libraryId: string; password: string; master: Buffer; activated: boolean }[] = [];
  const engine = new RestoreEngine({
    ...world.deps,
    reestablishLock: ({ libraryId, password, masterKey }) => {
      calls.push({
        libraryId,
        password,
        master: Buffer.from(masterKey),
        activated: existsSync(join(world.targetDir, 'library.db')) && !existsSync(`${world.targetDir}.restore-staging`),
      });
      return Promise.resolve();
    },
  });
  const result = await engine.run({ masterKey: world.masterKey, allowReplace: false, custodyPassword: 'fresh app pw' });
  assert.equal(result.libraryId, LIBRARY_ID);
  assert.equal(calls.length, 1, 'exactly one custody record is written per restore');
  assert.equal(calls[0]?.libraryId, LIBRARY_ID);
  assert.equal(calls[0]?.password, 'fresh app pw');
  assert.deepEqual(calls[0]?.master, world.masterKey);
  assert.equal(calls[0]?.activated, true, 'custody is written for the activated library, never the staging copy');
});

test('restore engine: without fresh authority no app-lock record is written (#754)', async () => {
  const world = await restoreWorld();
  let calls = 0;
  const engine = new RestoreEngine({
    ...world.deps,
    reestablishLock: () => {
      calls += 1;
      return Promise.resolve();
    },
  });
  await engine.run({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(calls, 0, 'an unconfigured lock must not gain a password-derived record');
});

test('restore engine: a custody write failure never undoes a committed activation (#754)', async () => {
  const world = await restoreWorld();
  const engine = new RestoreEngine({
    ...world.deps,
    reestablishLock: () => Promise.reject(new Error('keychain unavailable')),
  });
  const result = await engine.run({ masterKey: world.masterKey, allowReplace: false, custodyPassword: 'pw' });
  assert.equal(result.libraryId, LIBRARY_ID);
  assert.equal(existsSync(join(world.targetDir, 'library.db')), true, 'the restored library stays activated');
});

function ledgerStatus(targetDir: string, photoId: string): { status: string; lastBackupAt: string | null } | undefined {
  const keys = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: targetDir });
  const dbKey = keys.resolver()(1);
  assert.ok(dbKey !== undefined);
  const db = openLibraryDatabase({ path: join(targetDir, 'library.db'), dbKey });
  try {
    return queryGet<{ status: string; lastBackupAt: string | null }>(
      db,
      `SELECT status, last_backup_at AS lastBackupAt FROM sync_ledger WHERE photo_id = ?`,
      photoId,
    );
  } finally {
    db.close();
  }
}

test('restore engine: when every generation misses the same blobs, the newest restores only verified photos and reports every NOT FOUND object (#915/#947)', async () => {
  const world = await restoreWorld(3);
  const [kept, lostA, lostB] = world.photos;
  assert.ok(kept !== undefined && lostA !== undefined && lostB !== undefined);
  await world.provider.delete(lostA.blobPath);
  await world.provider.delete(lostB.blobPath);

  const result = await new RestoreEngine(world.deps).run({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(result.generation, 1);
  assert.equal(result.photos, 1, 'the healed catalog counts only the verified photo');
  assert.deepEqual(
    [...result.missing].sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: lostA.blobPath, kind: 'original', photoId: lostA.id, reason: 'not-found' },
      { path: lostB.blobPath, kind: 'original', photoId: lostB.id, reason: 'not-found' },
    ].sort((a, b) => a.path.localeCompare(b.path)),
    'every missing object is reported, not just the first',
  );

  const restoredKeys = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: world.targetDir });
  const restoredStore = new BlobStore({ dataDir: world.targetDir });
  await restoredStore.init();
  assert.equal(await restoredStore.verifyOriginal(kept.contentHash, restoredKeys.resolver(), kept.id), true);
  assert.equal(restoredStore.hasOriginal(lostA.contentHash), false, 'nothing fabricated for a NOT FOUND original');

  assert.deepEqual(ledgerStatus(world.targetDir, kept.id), { status: 'synced', lastBackupAt: GENERATED_AT });
  assert.equal(ledgerStatus(world.targetDir, lostA.id), undefined, 'a missing original cannot leave an unrestorable photo row');
  assert.equal(ledgerStatus(world.targetDir, lostB.id), undefined, 'every failed photo is absent from the healed catalog');

  const report = JSON.parse(await readFile(join(world.targetDir, 'restore-report.json'), 'utf8')) as {
    version: number;
    generation: number;
    missing: readonly { path: string }[];
  };
  assert.equal(report.version, 1);
  assert.equal(report.generation, 1);
  assert.equal(report.missing.length, 2, 'the NOT FOUND report survives the post-activation relaunch');
  assert.equal(world.progress.at(-1)?.stage, 'complete');
});

test('restore engine: a present-but-unverifiable blob is reported and omitted from the healed catalog (#915/#947)', async () => {
  const world = await restoreWorld(2);
  const [kept, damaged] = world.photos;
  assert.ok(kept !== undefined && damaged !== undefined);
  await put(world.provider, damaged.blobPath, Buffer.from('not an envelope'));

  const result = await new RestoreEngine(world.deps).run({ masterKey: world.masterKey, allowReplace: false });
  assert.deepEqual(result.missing, [{ path: damaged.blobPath, kind: 'original', photoId: damaged.id, reason: 'failed-verification' }]);
  const restoredKeys = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: world.targetDir });
  const restoredStore = new BlobStore({ dataDir: world.targetDir });
  await restoredStore.init();
  assert.equal(await restoredStore.verifyOriginal(kept.contentHash, restoredKeys.resolver(), kept.id), true);
  assert.equal(restoredStore.hasOriginal(damaged.contentHash), false, 'the unverifiable download never enters the store');
  assert.equal(result.photos, 1, 'the restored count excludes the unverifiable photo');
  assert.equal(ledgerStatus(world.targetDir, damaged.id), undefined, 'the unverifiable photo has no catalog or ledger row');
});

test('restore engine: a pre-#548 manifest whose photos lack the mediaInfo key restores cleanly', async () => {
  // GEN 59 incident shape: manifests generated before probed media info
  // existed carry photos with NO mediaInfo key. The manifest schema keeps
  // absence (parsing must not insert keys); the rebuilt snapshot always
  // emits mediaInfo, so the catalog equality check must normalize.
  const world = await restoreWorld(2);
  const legacyPhotos = world.photos.map(({ mediaInfo: _mediaInfo, ...photo }) => photo);
  await put(world.provider, 'manifest/gen-1.ovlk', await sealManifest(makeManifest(legacyPhotos), world.keyStore));

  const result = await new RestoreEngine(world.deps).run({ masterKey: world.masterKey, allowReplace: false });
  assert.deepEqual(result, { libraryId: LIBRARY_ID, generation: 1, photos: 2, resumed: false, missing: [] });
});

test('restore engine: a pre-#548 manifest with a NOT FOUND blob still partial-restores the verified photos', async () => {
  const world = await restoreWorld(3);
  const legacyPhotos = world.photos.map(({ mediaInfo: _mediaInfo, ...photo }) => photo);
  await put(world.provider, 'manifest/gen-1.ovlk', await sealManifest(makeManifest(legacyPhotos), world.keyStore));
  const lost = world.photos[2];
  assert.ok(lost !== undefined);
  await world.provider.delete(lost.blobPath);

  const result = await new RestoreEngine(world.deps).run({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(result.photos, 2, 'the verified projection restores without a false catalog mismatch');
  assert.deepEqual(result.missing, [{ path: lost.blobPath, kind: 'original', photoId: lost.id, reason: 'not-found' }]);
});

test('restore engine: a failed app-lock anchor reset never undoes activation (#754)', async () => {
  const world = await restoreWorld();
  const result = await new RestoreEngine({
    ...world.deps,
    resetLockAnchor: () => {
      throw new Error('anchor unavailable');
    },
  }).run({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(result.libraryId, LIBRARY_ID);
  assert.equal(existsSync(join(world.targetDir, 'library.db')), true);
});

test('verify refuses when the OS keychain cannot protect the recovered master', async () => {
  const world = await restoreWorld();
  await assert.rejects(
    () =>
      new RestoreEngine({
        ...world.deps,
        safeStorage: { ...fakeSafeStorage, isEncryptionAvailable: () => false },
      }).verify({ masterKey: world.masterKey, allowReplace: false }),
    isReason('io'),
  );
});

/** The photo shape schema 2 shipped with (#289): no mediaInfo (#548), no
 * isOriginal (#482), no metadata block. Frozen as an explicit pick so photos
 * built by today's helpers cannot leak later fields into the era fixtures. */
function legacyEraPhoto(photo: BackupManifestPhotoV2): BackupManifestPhotoV2 {
  return {
    id: photo.id,
    fileName: photo.fileName,
    fileKind: photo.fileKind,
    width: photo.width,
    height: photo.height,
    bytes: photo.bytes,
    contentHash: photo.contentHash,
    blobPath: photo.blobPath,
    camera: photo.camera,
    lens: photo.lens,
    iso: photo.iso,
    aperture: photo.aperture,
    shutter: photo.shutter,
    focalLength: photo.focalLength,
    takenAt: photo.takenAt,
    gpsLat: photo.gpsLat,
    gpsLon: photo.gpsLon,
    place: photo.place,
    importedAt: photo.importedAt,
    importSource: photo.importSource,
    favorite: photo.favorite,
    keyId: photo.keyId,
    deletedAt: photo.deletedAt,
  };
}

/** A manifest exactly as each schema era would have written it: the era's
 * sections with era-original photo shapes, validated by the era's schema. */
function makeEraManifest(schema: 2 | 3 | 4 | 5 | 6, photos: readonly BackupManifestPhotoV2[]): unknown {
  const v2 = makeManifest(photos);
  if (schema === 2) return v2;
  const v3 = { ...v2, schema: 3, protectedAlbums: [], protectedPhotos: [] };
  if (schema === 3) return backupManifestV3Schema.parse(v3);
  const v4 = { ...v3, schema: 4, activity: [] };
  if (schema === 4) return backupManifestV4Schema.parse(v4);
  const v5 = { ...v4, schema: 5, boards: [] };
  if (schema === 5) return backupManifestV5Schema.parse(v5);
  return backupManifestV6Schema.parse({ ...v5, schema: 6, sidecars: [] });
}

test('restore engine: a manifest from every supported schema era (2..6) restores cleanly (#1009 structural fix)', async () => {
  // Legacy generations are data at rest — they never get rewritten, so every
  // era must keep restoring forever. A future manifest field that the rebuilt
  // snapshot always emits will fail here until the parse-time migration
  // (upgradeLegacyManifest) learns to normalize it; the alternative is
  // rejecting every pre-existing backup as corrupt in production (GEN 59).
  for (const schema of [2, 3, 4, 5, 6] as const) {
    const world = await restoreWorld(2);
    const eraManifest = makeEraManifest(schema, world.photos.map(legacyEraPhoto));
    await put(world.provider, 'manifest/gen-1.ovlk', await sealManifest(eraManifest, world.keyStore));

    const result = await new RestoreEngine(world.deps).run({ masterKey: world.masterKey, allowReplace: false });
    assert.equal(result.generation, 1, `schema-${String(schema)} era manifest restores`);
    assert.equal(result.photos, 2, `schema-${String(schema)} era manifest restores every photo`);
    assert.deepEqual(result.missing, [], `schema-${String(schema)} era manifest restores without gaps`);
    assert.equal(world.progress.at(-1)?.stage, 'complete', `schema-${String(schema)} era restore completes`);
  }
});

test('restore engine: re-running after the missing object is recovered fills the gap (#915)', async () => {
  const world = await restoreWorld(2);
  const [, lost] = world.photos;
  assert.ok(lost !== undefined);
  const ciphertext = await buffer(await world.provider.getStream(lost.blobPath));
  await world.provider.delete(lost.blobPath);

  const partial = await new RestoreEngine(world.deps).run({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(partial.missing.length, 1);

  await put(world.provider, lost.blobPath, ciphertext);
  const filled = await new RestoreEngine(world.deps).run({ masterKey: world.masterKey, allowReplace: true });
  assert.deepEqual(filled.missing, [], 'a complete generation restores strictly on the re-run');
  const restoredKeys = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: world.targetDir });
  const restoredStore = new BlobStore({ dataDir: world.targetDir });
  await restoredStore.init();
  assert.equal(await restoredStore.verifyOriginal(lost.contentHash, restoredKeys.resolver(), lost.id), true);
  assert.deepEqual(ledgerStatus(world.targetDir, lost.id), { status: 'synced', lastBackupAt: GENERATED_AT });
  assert.equal(existsSync(join(world.targetDir, 'restore-report.json')), false, 'a complete re-run leaves no stale NOT FOUND report');
});
