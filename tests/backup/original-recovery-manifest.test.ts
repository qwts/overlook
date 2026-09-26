import { probeKeyAgainstStore } from '../../src/main/crypto/keyring-probe.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';
import { buildBackupManifestV14 } from '../../src/main/backup/backup-manifest.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { sealRecoveryBootstrap } from '../../src/main/backup/recovery-bootstrap.js';
import { RestoreEngine } from '../../src/main/backup/restore-engine.js';
import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { createEncryptStream } from '../../src/main/crypto/envelope.js';
import { KeyStore, type SafeStorageLike } from '../../src/main/crypto/keystore.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { KeyringRepository } from '../../src/main/db/keyring-repository.js';
import { OriginalAvailabilityRepository } from '../../src/main/db/original-availability.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { VariantRepository } from '../../src/main/db/variant-repository.js';
import { run } from '../../src/main/db/sql.js';
import { OriginalRecoveryService } from '../../src/main/library/original-recovery-service.js';
import { sampleJpeg } from '../../src/main/library/seed.js';

const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
};
const LIBRARY_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const AT = '2026-09-22T00:00:00.000Z';

test('disaster restore retains remote-original key custody after excluded local recovery (#1101)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'overlook-recovery-manifest-'));
  const close: (() => void)[] = [];
  t.after(async () => {
    for (const release of close.reverse()) release();
    await rm(root, { recursive: true, force: true });
  });
  const dataDir = join(root, 'source');
  const keys = KeyStore.open({ safeStorage, dataDir });
  close.push(() => keys.close());
  const dbKey = keys.resolver()(1);
  assert.ok(dbKey);
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey });
  close.push(() => db.close());
  const oldKey = keys.rotate();
  for (const id of [1, oldKey.id]) run(db, "INSERT INTO keys (id, wrapped_key, created_at) VALUES (?, 'test', ?)", id, AT);
  const bytes = sampleJpeg(1);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const photos = new PhotosRepository(db);
  photos.insert({
    id: 'root',
    fileName: 'photo.jpg',
    fileKind: 'jpeg',
    width: 30,
    height: 20,
    bytes: bytes.length,
    contentHash: hash,
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
    importedAt: AT,
    importSource: 'test',
    keyId: oldKey.id,
  });
  const original = photos.get('root');
  assert.ok(original);
  new VariantRepository(db).duplicate(original, 'sibling', AT);
  photos.softDelete(['sibling']);
  run(db, "UPDATE sync_ledger SET coverage = 'excluded', status = 'error', dirty = 0 WHERE photo_id = 'root'");
  run(db, "UPDATE sync_ledger SET status = 'synced', dirty = 0 WHERE photo_id = 'sibling'");
  run(db, "UPDATE photos SET original_failure = 'missing-original'");
  const blobs = new BlobStore({ dataDir });
  await blobs.init();
  await blobs.putOriginal(Readable.from([bytes]), oldKey, 'root');
  const provider = new MockProvider({ rootDir: join(root, 'remote'), libraryId: LIBRARY_ID });
  const path = `blobs/${hash.slice(0, 2)}/${hash}`;
  await provider.put(path, blobs.getEncryptedStream(hash));
  const remoteBefore = await provider.verify(path);
  await blobs.deleteOriginal(hash);
  const active = keys.rotate();
  run(db, "INSERT INTO keys (id, wrapped_key, created_at) VALUES (?, 'test', ?)", active.id, AT);
  const source = join(root, 'matching.jpg');
  await writeFile(source, bytes);
  const availability = new OriginalAvailabilityRepository(db);
  const recovery = new OriginalRecoveryService({
    getPhoto: (id) => photos.get(id),
    blobs,
    ready: Promise.resolve(),
    writeKey: () => ({ ...active, key: Buffer.from(active.key) }),
    resolveKey: keys.resolver(),
    restored: (contentHash, keyId) => {
      availability.recoveredLocal(contentHash, keyId);
    },
  });
  assert.equal(await recovery.recover('root', source), 'recovered');
  assert.deepEqual(photos.dirtyPhotos(), [], 'excluded and deleted rows do not upload replacement ciphertext');
  assert.deepEqual(await provider.verify(path), remoteBefore);
  // A later unrelated backup publishes this catalog while the remote original
  // remains under its former key. Exercise actual discovery, download, and rebuild.
  const manifest = buildBackupManifestV14({
    libraryId: LIBRARY_ID,
    generatedAt: AT,
    snapshot: {
      ...photos.manifestSnapshot(),
      protectedAlbums: [],
      protectedPhotos: [],
      activity: [],
      boards: [],
      sidecars: [],
      galleryPolicy: photos.galleryPolicy(),
      hiddenAlbumIds: [],
      folders: [],
      albumTree: [],
      smartAlbums: [],
      editRevisions: [],
      provenance: [],
      variantFamilies: [],
    },
  });
  const masterKey = keys.masterKeyBytes();
  await provider.put(
    'recovery/bootstrap.ovrb',
    Readable.from([
      sealRecoveryBootstrap(
        {
          schema: 1,
          libraryId: LIBRARY_ID,
          generatedAt: AT,
          keys: keys.exportWrappedKeys(),
        },
        masterKey,
      ),
    ]),
  );
  const sealed = await buffer(
    Readable.from([Buffer.from(JSON.stringify(manifest))]).pipe(createEncryptStream(keys.currentKey(), { photoId: 'manifest' })),
  );
  await provider.put('manifest/gen-1.ovlk', Readable.from([sealed]));
  const targetDir = join(root, 'restored');
  const engine = new RestoreEngine({
    provider,
    targetDir,
    safeStorage,
    availableBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    thumbnails: (store) => ({
      generateFor: async (request) => {
        for (const size of ['thumb', 'mid'] as const)
          await store.putThumb(Readable.from([bytes]), request.key, request.photoId, request.contentHash, size);
        return { generated: true, width: 30, height: 20 };
      },
    }),
    events: { progress: () => undefined },
  });
  await engine.verify({ masterKey, allowReplace: false });
  await engine.run({ masterKey, allowReplace: false });
  const restoredKeys = KeyStore.open({ safeStorage, dataDir: targetDir });
  close.push(() => restoredKeys.close());
  const restoredDbKey = restoredKeys.resolver()(1);
  assert.ok(restoredDbKey);
  const restoredDb = openLibraryDatabase({ path: join(targetDir, 'library.db'), dbKey: restoredDbKey });
  close.push(() => restoredDb.close());
  const restored = new PhotosRepository(restoredDb);
  assert.ok(restored.get('sibling')?.deletedAt);
  assert.equal(restored.get('root')?.coverage, 'excluded');
  assert.ok(
    new KeyringRepository(restoredDb).usage(oldKey.id).photos > 0,
    'the key sealing the restored original must remain owned, not removable as unused',
  );
  assert.ok(
    new KeyringRepository(restoredDb).usage(restoredKeys.currentKey().id).photos > 0,
    'the fresh key sealing rebuilt derivatives must also remain owned',
  );
  const restoredBlobs = new BlobStore({ dataDir: targetDir });
  const material = restoredKeys.keyBytes(oldKey.id);
  assert.ok(material);
  try {
    assert.equal(
      await probeKeyAgainstStore(restoredDb, restoredBlobs, oldKey.id, material),
      true,
      'the retained original authenticates its shared owner during key re-import',
    );
  } finally {
    material.fill(0);
  }
});
