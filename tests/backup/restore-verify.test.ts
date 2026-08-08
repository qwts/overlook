import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { buildBackupManifestV2, type BackupManifestPhotoV2 } from '../../src/main/backup/backup-manifest.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import type { StorageProvider } from '../../src/main/backup/provider.js';
import { sealRecoveryBootstrap } from '../../src/main/backup/recovery-bootstrap.js';
import { RestoreEngine, type RestoreEngineDeps } from '../../src/main/backup/restore-engine.js';
import { RestoreError, type RestoreProgress } from '../../src/main/backup/restore-types.js';
import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { createEncryptStream } from '../../src/main/crypto/envelope.js';
import { KeyStore, type SafeStorageLike } from '../../src/main/crypto/keystore.js';
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
  return { provider, masterKey, targetDir, photos, deps };
}

test('verify classifies 1 missing + 1 corrupt, does not activate staging, and is idempotent', async () => {
  const world = await verifyWorld(3);
  const [kept, missing, corrupt] = world.photos;
  assert.ok(kept !== undefined && missing !== undefined && corrupt !== undefined);
  await world.provider.delete(missing.blobPath);
  await put(world.provider, corrupt.blobPath, Buffer.from('not-an-envelope'));

  const engine = new RestoreEngine(world.deps);
  const result = await engine.verify({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(result.missing.length, 2);
  assert.equal(result.missingCount, 1);
  assert.equal(result.corruptCount, 1);
  assert.equal(result.verifiedCount, 1);
  assert.equal(result.photos, 3);
  const reasons = new Map(result.missing.map((m) => [m.path, m.reason]));
  assert.equal(reasons.get(missing.blobPath), 'not-found');
  assert.equal(reasons.get(corrupt.blobPath), 'failed-verification');
  assert.equal(existsSync(join(world.targetDir, 'library.db')), false);
  assert.equal(existsSync(`${world.targetDir}.restore-staging`), false);

  const second = await engine.verify({ masterKey: world.masterKey, allowReplace: false });
  assert.deepEqual(
    [...second.missing].sort((a, b) => a.path.localeCompare(b.path)),
    [...result.missing].sort((a, b) => a.path.localeCompare(b.path)),
  );

  const runResult = await new RestoreEngine(world.deps).run({ masterKey: world.masterKey, allowReplace: false });
  assert.equal(runResult.missing.length, 2);
  assert.equal(existsSync(join(world.targetDir, 'library.db')), true);
  void kept;
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
});
