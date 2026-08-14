import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { buildBackupManifestV2, buildBackupManifestV6, type BackupManifestPhotoV2 } from '../../src/main/backup/backup-manifest.js';
import { createManifestDebtStore } from '../../src/main/backup/manifest-debt.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { ProviderError, type StorageProvider } from '../../src/main/backup/provider.js';
import { sealRecoveryBootstrap } from '../../src/main/backup/recovery-bootstrap.js';
import { RestoreEngine, type RestoreEngineDeps } from '../../src/main/backup/restore-engine.js';
import { projectVerifiedManifest } from '../../src/main/backup/restore-projection.js';
import { RestoreError, type RestoreProgress } from '../../src/main/backup/restore-types.js';
import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { createEncryptStream } from '../../src/main/crypto/envelope.js';
import { KeyStore, type SafeStorageLike } from '../../src/main/crypto/keystore.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { sampleJpeg } from '../../src/main/library/seed.js';

const LIBRARY_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const GENERATED_AT = '2026-07-14T23:00:00.000Z';

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => value.toString('utf8'),
};

async function put(provider: StorageProvider, path: string, bytes: Buffer): Promise<void> {
  await provider.put(path, Readable.from([bytes]));
}

async function sealManifest(value: unknown, keyStore: KeyStore): Promise<Buffer> {
  return buffer(
    Readable.from([Buffer.from(JSON.stringify(value))]).pipe(createEncryptStream(keyStore.currentKey(), { photoId: 'manifest' })),
  );
}

function makeManifest(photos: readonly BackupManifestPhotoV2[]): ReturnType<typeof buildBackupManifestV2> {
  return buildBackupManifestV2({
    libraryId: LIBRARY_ID,
    generatedAt: GENERATED_AT,
    snapshot: {
      databaseSchema: 3,
      keyIds: [1],
      totals: { photos: photos.length, bytes: photos.reduce((sum, p) => sum + p.bytes, 0), albums: 1 },
      photos,
      albums: [{ id: 'A1', name: 'Recovered', createdAt: GENERATED_AT, position: 0, photoIds: photos.map((p) => p.id) }],
    },
  });
}

async function verifyWorld(count = 3): Promise<{
  provider: MockProvider;
  masterKey: Buffer;
  targetDir: string;
  photos: readonly BackupManifestPhotoV2[];
  keyStore: KeyStore;
  deps: RestoreEngineDeps;
}> {
  const sourceDir = mkdtempSync(join(tmpdir(), 'overlook-verify-source-'));
  const targetDir = join(mkdtempSync(join(tmpdir(), 'overlook-verify-target-')), 'library');
  const keyStore = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: sourceDir });
  const masterKey = keyStore.masterKeyBytes();
  const sourceStore = new BlobStore({ dataDir: sourceDir });
  await sourceStore.init();
  const photos: BackupManifestPhotoV2[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `P${String(i + 1)}`;
    const bytes = sampleJpeg(i + 1);
    const ref = await sourceStore.putOriginal(Readable.from([bytes]), keyStore.currentKey(), id);
    photos.push({
      id,
      fileName: `IMG_${String(i + 1)}.JPG`,
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
      importedAt: `2026-07-14T23:00:0${String(i)}.000Z`,
      importSource: 'cloud-restore',
      favorite: i === 0,
      keyId: ref.keyId,
      deletedAt: null,
    });
  }
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-verify-remote-')), libraryId: LIBRARY_ID });
  for (const p of photos) await put(provider, p.blobPath, await buffer(sourceStore.getEncryptedStream(p.contentHash)));
  await put(
    provider,
    'recovery/bootstrap.ovrb',
    sealRecoveryBootstrap({ schema: 1, libraryId: LIBRARY_ID, generatedAt: GENERATED_AT, keys: keyStore.exportWrappedKeys() }, masterKey),
  );
  await put(provider, 'manifest/gen-1.ovlk', await sealManifest(makeManifest(photos), keyStore));
  const progress: RestoreProgress[] = [];
  const deps: RestoreEngineDeps = {
    provider,
    targetDir,
    safeStorage: fakeSafeStorage,
    availableBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    thumbnails: (store) => ({
      generateFor: async (request): Promise<{ generated: boolean; width: number; height: number }> => {
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
    events: { progress: (v) => progress.push(v) },
  };
  return { provider, masterKey, targetDir, photos, keyStore, deps };
}

test('verify classifies missing originals without downloading; heal restore skips them', async () => {
  const world = await verifyWorld(3);
  const [kept, missing, corrupt] = world.photos;
  assert.ok(kept !== undefined && missing !== undefined && corrupt !== undefined);
  await world.provider.delete(missing.blobPath);
  await put(world.provider, corrupt.blobPath, Buffer.from('not-an-envelope'));

  const engine = new RestoreEngine(world.deps);
  const result = await engine.verify({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(result.missing.length, 1);
  assert.equal(result.missingCount, 1);
  assert.equal(result.corruptCount, 0);
  assert.equal(result.verifiedCount, 2);
  assert.equal(result.photos, 3);
  assert.equal(result.missing[0]?.path, missing.blobPath);
  assert.equal(result.missing[0]?.reason, 'not-found');
  assert.equal(existsSync(join(world.targetDir, 'library.db')), false);
  assert.equal(existsSync(`${world.targetDir}.restore-staging`), false);

  const second = await engine.verify({ masterKey: world.masterKey, allowReplace: false });
  assert.deepEqual(
    [...second.missing].sort((a, b) => a.path.localeCompare(b.path)),
    [...result.missing].sort((a, b) => a.path.localeCompare(b.path)),
  );

  const gets: string[] = [];
  const getStream = world.provider.getStream.bind(world.provider);
  world.provider.getStream = (path) => {
    gets.push(path);
    return getStream(path);
  };
  const runResult = await new RestoreEngine(world.deps).run({
    masterKey: world.masterKey,
    allowReplace: false,
    verification: result,
  });
  assert.equal(gets.includes(missing.blobPath), false);
  assert.equal(gets.includes(corrupt.blobPath), true);
  assert.equal(runResult.missing.length, 2);
  assert.equal(runResult.photos, 1);
  assert.equal(existsSync(join(world.targetDir, 'library.db')), true);
  const restoredKeys = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: world.targetDir });
  const dbKey = restoredKeys.resolver()(1);
  assert.ok(dbKey);
  const db = openLibraryDatabase({ path: join(world.targetDir, 'library.db'), dbKey });
  try {
    const repo = new PhotosRepository(db);
    assert.deepEqual(
      repo.manifestSnapshot().photos.map((photo) => photo.id),
      [kept.id],
    );
    assert.deepEqual(repo.manifestSnapshot().albums[0]?.photoIds, [kept.id]);
    assert.equal(repo.manifestSnapshot().totals.photos, 1);
    assert.equal(repo.manifestSnapshot().totals.bytes, kept.bytes);
    assert.equal(createManifestDebtStore(db).load(), true);
  } finally {
    db.close();
    restoredKeys.close();
  }
});

test('verify is cancellable via AbortSignal', async () => {
  const world = await verifyWorld(2);
  const engine = new RestoreEngine(world.deps);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => engine.verify({ masterKey: world.masterKey, allowReplace: false, signal: ac.signal }),
    (e: unknown) => e instanceof RestoreError && e.reason === 'cancelled',
  );
});

test('verify with all blobs present reports zero missing/corrupt', async () => {
  const world = await verifyWorld(2);
  const result = await new RestoreEngine(world.deps).verify({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(result.missing.length, 0);
  assert.equal(result.missingCount, 0);
  assert.equal(result.corruptCount, 0);
  assert.equal(result.verifiedCount, 2);
  assert.match(result.objectSetSha256, /^[a-f0-9]{64}$/u);
});

test('a bound plan still activates when extra objects fail after the scan', async () => {
  const world = await verifyWorld(2);
  const engine = new RestoreEngine(world.deps);
  const plan = await engine.verify({ masterKey: world.masterKey, allowReplace: false });
  const [changed, kept] = world.photos;
  assert.ok(changed && kept);
  await put(world.provider, changed.blobPath, Buffer.from('changed after scan'));
  const result = await engine.run({ masterKey: world.masterKey, allowReplace: false, verification: plan });
  assert.equal(result.photos, 1);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0]?.path, changed.blobPath);
  assert.equal(result.missing[0]?.reason, 'failed-verification');
  assert.equal(existsSync(join(world.targetDir, 'library.db')), true);
});

test('a verification plan refuses activation when the sealed manifest changes', async () => {
  const world = await verifyWorld(2);
  const engine = new RestoreEngine(world.deps);
  const plan = await engine.verify({ masterKey: world.masterKey, allowReplace: false });
  await assert.rejects(
    () =>
      engine.run({
        masterKey: world.masterKey,
        allowReplace: false,
        verification: { ...plan, sealedManifestSha256: 'f'.repeat(64) },
      }),
    (error: unknown) => error instanceof RestoreError && error.reason === 'corrupt' && /changed after verification/u.test(error.message),
  );
  assert.equal(existsSync(join(world.targetDir, 'library.db')), false);
});

test('verify emits per-object discovering/verifying progress', async () => {
  const world = await verifyWorld(3);
  const progress: RestoreProgress[] = [];
  const engine = new RestoreEngine({ ...world.deps, events: { progress: (value) => progress.push(value) } });
  await engine.verify({ masterKey: world.masterKey, allowReplace: false });
  const verifying = progress.filter((item) => item.stage === 'verifying');
  assert.ok(verifying.length >= 4);
  assert.equal(verifying[0]?.done, 0);
  assert.equal(verifying[0]?.total, 3);
  assert.equal(verifying.at(-1)?.done, 3);
  assert.equal(verifying.at(-1)?.total, 3);
});

test('a listing miss is not NOT FOUND when probe can still see the object (#969/#994)', async () => {
  const world = await verifyWorld(2);
  const hidden = new Set(world.photos.map((photo) => photo.blobPath));
  const list = world.provider.list.bind(world.provider);
  world.provider.list = async (prefix, signal) => (await list(prefix, signal)).filter((entry) => !hidden.has(entry.path));
  const engine = new RestoreEngine(world.deps);
  const plan = await engine.verify({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(plan.missing.length, 0);
  assert.equal(plan.verifiedCount, 2);
  const result = await engine.run({ masterKey: world.masterKey, allowReplace: false, verification: plan });
  assert.equal(result.photos, 2);
  assert.equal(result.missing.length, 0);
  assert.equal(existsSync(join(world.targetDir, 'library.db')), true);
});

test('probe not-found is still NOT FOUND after a listing miss (#969/#994)', async () => {
  const world = await verifyWorld(1);
  const photo = world.photos[0];
  assert.ok(photo);
  await world.provider.delete(photo.blobPath);
  const list = world.provider.list.bind(world.provider);
  world.provider.list = async (prefix, signal) => (await list(prefix, signal)).filter((entry) => entry.path !== photo.blobPath);
  const result = await new RestoreEngine(world.deps).verify({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0]?.reason, 'not-found');
  assert.equal(result.verifiedCount, 0);
});

test('a transient provider read remains retryable and is never classified as corrupt', async () => {
  const world = await verifyWorld(1);
  const photo = world.photos[0];
  assert.ok(photo);
  const list = world.provider.list.bind(world.provider);
  const probe = world.provider.probe.bind(world.provider);
  world.provider.list = async (prefix, signal) => (await list(prefix, signal)).filter((entry) => !entry.path.startsWith('blobs/'));
  world.provider.probe = (path, signal) =>
    path === photo.blobPath
      ? Promise.reject(new ProviderError('provider is temporarily offline', 'transient', 'object'))
      : probe(path, signal);
  await assert.rejects(
    () => new RestoreEngine(world.deps).verify({ masterKey: world.masterKey, allowReplace: false }),
    (error: unknown) => error instanceof ProviderError && error.kind === 'transient',
  );
});

test('verify does not download original bodies (#994)', async () => {
  const world = await verifyWorld(2);
  const gets: string[] = [];
  const getStream = world.provider.getStream.bind(world.provider);
  world.provider.getStream = (path) => {
    gets.push(path);
    return getStream(path);
  };
  const plan = await new RestoreEngine(world.deps).verify({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(plan.verifiedCount, 2);
  assert.deepEqual(
    gets.filter((path) => path.startsWith('blobs/')),
    [],
  );
});

test('verified projection drops failed originals, memberships, sidecars, and protected records but preserves history', async () => {
  const world = await verifyWorld(2);
  const [lost, kept] = world.photos;
  assert.ok(lost && kept);
  const protectedAlbum = {
    id: 'secret-album',
    credentialGeneration: 1,
    metadataGeneration: 1,
    credentialRecord: Buffer.from('credential').toString('base64'),
    sealedMetadata: Buffer.from('album').toString('base64'),
    createdAt: GENERATED_AT,
    updatedAt: GENERATED_AT,
  };
  const protectedPhoto = (id: string, blobRef: string) => ({
    id,
    albumId: protectedAlbum.id,
    blobRef,
    sealedMetadata: Buffer.from(id).toString('base64'),
    createdAt: GENERATED_AT,
    updatedAt: GENERATED_AT,
    objects: [
      {
        kind: 'original' as const,
        path: `protected/${blobRef.slice(0, 2)}/${blobRef}.original`,
        sha256: 'e'.repeat(64),
        bytes: 9,
        status: 'synced' as const,
      },
    ],
  });
  const lostProtected = protectedPhoto('secret-lost', 'a'.repeat(64));
  const keptProtected = protectedPhoto('secret-kept', 'b'.repeat(64));
  const sidecar = (photoId: string, hash: string) => ({
    photoId,
    role: 'xmp' as const,
    fileName: `${photoId}.xmp`,
    hash,
    bytes: 7,
    keyId: 1,
    blobPath: `sidecars/${photoId}/${hash}`,
    ciphertext: { sha256: 'd'.repeat(64), bytes: 11 },
  });
  const keptSidecar = sidecar(kept.id, 'c'.repeat(64));
  const manifest = buildBackupManifestV6({
    libraryId: LIBRARY_ID,
    generatedAt: GENERATED_AT,
    snapshot: {
      databaseSchema: 3,
      keyIds: [1],
      totals: { photos: 2, bytes: lost.bytes + kept.bytes, albums: 1 },
      photos: [lost, kept],
      albums: [{ id: 'A1', name: 'Recovered', createdAt: GENERATED_AT, position: 0, photoIds: [lost.id, kept.id] }],
      protectedAlbums: [protectedAlbum],
      protectedPhotos: [lostProtected, keptProtected],
      activity: [],
      boards: [],
      sidecars: [sidecar(lost.id, 'f'.repeat(64)), keptSidecar],
    },
  });
  const projected = projectVerifiedManifest(manifest, [
    { path: lost.blobPath, kind: 'original', photoId: lost.id, reason: 'not-found' },
    { path: keptSidecar.blobPath, kind: 'sidecar', photoId: kept.id, reason: 'failed-verification' },
    { path: lostProtected.objects[0]?.path ?? '', kind: 'protected', photoId: lostProtected.id, reason: 'not-found' },
  ]);
  assert.equal(projected.schema, 6);
  if (projected.schema !== 6) assert.fail('schema-6 projection must remain schema 6');
  assert.deepEqual(
    projected.photos.map((photo) => photo.id),
    [kept.id],
  );
  assert.deepEqual(projected.albums[0]?.photoIds, [kept.id]);
  assert.deepEqual(projected.totals, { photos: 1, bytes: kept.bytes, albums: 1 });
  assert.deepEqual(projected.sidecars, []);
  assert.deepEqual(
    projected.protectedPhotos.map((photo) => photo.id),
    [keptProtected.id],
  );
  assert.deepEqual(projected.protectedAlbums, [protectedAlbum]);
  assert.deepEqual(projected.activity, manifest.activity);
  assert.deepEqual(projected.boards, manifest.boards);
});

test('verify classifies missing and corrupt sidecars and protected objects independently', async () => {
  const world = await verifyWorld(1);
  const photo = world.photos[0];
  assert.ok(photo);
  const sidecar = (hash: string) => ({
    photoId: photo.id,
    role: 'xmp' as const,
    fileName: `${hash.slice(0, 2)}.xmp`,
    hash,
    bytes: 7,
    keyId: 1,
    blobPath: `sidecars/${photo.id}/${hash}`,
    ciphertext: { sha256: 'd'.repeat(64), bytes: 11 },
  });
  const missingSidecar = sidecar('1'.repeat(64));
  const corruptSidecar = sidecar('2'.repeat(64));
  await put(world.provider, corruptSidecar.blobPath, Buffer.from('not a sidecar envelope'));
  const protectedAlbum = {
    id: 'protected-album',
    credentialGeneration: 1,
    metadataGeneration: 1,
    credentialRecord: Buffer.from('credential').toString('base64'),
    sealedMetadata: Buffer.from('album').toString('base64'),
    createdAt: GENERATED_AT,
    updatedAt: GENERATED_AT,
  };
  const protectedPhoto = (id: string, blobRef: string) => ({
    id,
    albumId: protectedAlbum.id,
    blobRef,
    sealedMetadata: Buffer.from(id).toString('base64'),
    createdAt: GENERATED_AT,
    updatedAt: GENERATED_AT,
    objects: [
      {
        kind: 'original' as const,
        path: `protected/${blobRef.slice(0, 2)}/${blobRef}.original`,
        sha256: 'a'.repeat(64),
        bytes: 99,
        status: 'synced' as const,
      },
    ],
  });
  const missingProtected = protectedPhoto('protected-missing', '3'.repeat(64));
  const corruptProtected = protectedPhoto('protected-corrupt', '4'.repeat(64));
  await put(world.provider, corruptProtected.objects[0]?.path ?? '', Buffer.from('wrong protected ciphertext'));
  const manifest = buildBackupManifestV6({
    libraryId: LIBRARY_ID,
    generatedAt: GENERATED_AT,
    snapshot: {
      databaseSchema: 3,
      keyIds: [1],
      totals: { photos: 1, bytes: photo.bytes, albums: 1 },
      photos: [photo],
      albums: [{ id: 'A1', name: 'Recovered', createdAt: GENERATED_AT, position: 0, photoIds: [photo.id] }],
      protectedAlbums: [protectedAlbum],
      protectedPhotos: [missingProtected, corruptProtected],
      activity: [],
      boards: [],
      sidecars: [missingSidecar, corruptSidecar],
    },
  });
  await put(world.provider, 'manifest/gen-1.ovlk', await sealManifest(manifest, world.keyStore));
  const result = await new RestoreEngine(world.deps).verify({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(result.missingCount, 2);
  assert.equal(result.corruptCount, 2);
  assert.equal(result.verifiedCount, 1, 'ordinary-photo count is independent of companion/protected gaps');
  assert.deepEqual(
    [...result.missing]
      .map(({ path, kind, reason }) => ({ path, kind, reason }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    [
      { path: missingSidecar.blobPath, kind: 'sidecar', reason: 'not-found' },
      { path: corruptSidecar.blobPath, kind: 'sidecar', reason: 'failed-verification' },
      { path: missingProtected.objects[0]?.path ?? '', kind: 'protected', reason: 'not-found' },
      { path: corruptProtected.objects[0]?.path ?? '', kind: 'protected', reason: 'failed-verification' },
    ].sort((left, right) => left.path.localeCompare(right.path)),
  );
});
