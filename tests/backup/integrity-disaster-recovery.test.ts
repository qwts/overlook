import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';

import { BackupEngine } from '../../src/main/backup/backup-engine.js';
import { createBackupIntegrityRuntime } from '../../src/main/backup/integrity-runtime.js';
import { sealManifestJson } from '../../src/main/backup/manifest-sealer.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { createRecoveryHealthCheck } from '../../src/main/backup/recovery-health.js';
import { sealKeyStoreRecoveryBootstrap } from '../../src/main/backup/recovery-bootstrap.js';
import { RestoreEngine } from '../../src/main/backup/restore-engine.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { KeyStore, type SafeStorageLike } from '../../src/main/crypto/keystore.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import { sampleJpeg } from '../../src/main/library/seed.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

const LIBRARY_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => value.toString('utf8'),
};

test('repaired bootstrap and manifest restore the complete library into a fresh profile (#302)', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'overlook-integrity-dr-source-'));
  const targetRoot = mkdtempSync(join(tmpdir(), 'overlook-integrity-dr-target-'));
  const targetDir = join(targetRoot, 'library');
  let masterKey: Buffer | null = null;
  try {
    const keyStore = KeyStore.open({ safeStorage, dataDir: sourceDir });
    const dbKey = keyStore.resolver()(1);
    assert.ok(dbKey !== undefined);
    const db = openLibraryDatabase({ path: join(sourceDir, 'library.db'), dbKey });
    const activeKey = keyStore.exportWrappedKeys()[0];
    assert.ok(activeKey !== undefined);
    run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (?, ?, ?)`, activeKey.id, activeKey.wrappedKey, activeKey.createdAt);
    const repo = new PhotosRepository(db);
    const ledger = new SyncLedger(db);
    const store = new BlobStore({ dataDir: sourceDir });
    await store.init();
    const plaintext = sampleJpeg(42);
    const ref = await store.putOriginal(Readable.from([plaintext]), keyStore.currentKey(), 'P1');
    repo.insert({
      id: 'P1',
      fileName: 'RECOVER_ME.JPG',
      fileKind: 'jpeg',
      width: 1,
      height: 1,
      bytes: ref.bytes,
      contentHash: ref.contentHash,
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
      importedAt: '2026-07-15T03:00:00.000Z',
      importSource: 'integrity-contract',
      keyId: ref.keyId,
    } satisfies PhotoInsert);
    const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-integrity-dr-remote-')), libraryId: LIBRARY_ID });
    const scrubber = createBackupIntegrityRuntime({
      db,
      provider,
      authorities: { offloadedAuthorities: () => [] },
      custody: { resolveAuthority: () => Promise.reject(new Error('no offloaded authority')) },
      repo,
      blobs: store,
      resolveKey: keyStore.resolver(),
      markUnrecoverable: (photoId) => ledger.repairStatus(photoId, 'error'),
      audit: () => undefined,
    });
    let clock = Date.parse('2026-07-15T03:00:00.000Z');
    const engine = new BackupEngine({
      provider,
      ledger,
      dirtyPhotos: () => repo.dirtyPhotos(),
      encryptedStream: (hash) => store.getEncryptedStream(hash),
      sealManifest: (json) => sealManifestJson(json, keyStore.currentKey()),
      sealRecoveryBootstrap: (generatedAt) => sealKeyStoreRecoveryBootstrap({ keyStore, libraryId: LIBRARY_ID, generatedAt }),
      libraryId: () => LIBRARY_ID,
      manifestSnapshot: () => repo.manifestSnapshot(),
      settings: () => ({ throttlePercent: null, wifiOnly: false, autoBackupOnImport: false }),
      network: () => 'wifi',
      events: { progress: () => undefined },
      now: () => (clock += 1_000),
      sleep: () => Promise.resolve(),
      pendingCountChanged: () => undefined,
      syncStateChanged: () => undefined,
      audit: () => undefined,
      integrityScrub: () => scrubber.scrub(),
      recoveryGenerationHealthy: createRecoveryHealthCheck(provider, () => LIBRARY_ID, keyStore),
    });

    assert.equal((await engine.run()).integrity.failed, false);
    await provider.delete('recovery/bootstrap.ovrb');
    assert.equal((await engine.run()).integrity.recoveryRepaired, true, 'missing bootstrap publishes generation 2');
    await provider.put('manifest/gen-2.ovlk', Readable.from([Buffer.from('corrupt newest manifest')]));
    assert.equal((await engine.run()).integrity.recoveryRepaired, true, 'corrupt latest manifest publishes generation 3');

    masterKey = keyStore.masterKeyBytes();
    const restored = await new RestoreEngine({
      provider,
      targetDir,
      safeStorage,
      availableBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
      thumbnails: (targetStore) => ({
        generateFor: async (request) => {
          for (const size of ['thumb', 'mid'] as const) {
            await targetStore.putThumb(
              Readable.from([Buffer.from(`${size}:${request.photoId}`)]),
              request.key,
              request.photoId,
              request.contentHash,
              size,
            );
          }
          return { generated: true, width: 1, height: 1 };
        },
      }),
      events: { progress: () => undefined },
    }).run({ masterKey, allowReplace: false });
    assert.deepEqual(restored, { libraryId: LIBRARY_ID, generation: 3, photos: 1, resumed: false, missing: [] });

    const restoredKeys = KeyStore.open({ safeStorage, dataDir: targetDir });
    const restoredDbKey = restoredKeys.resolver()(1);
    assert.ok(restoredDbKey !== undefined);
    const restoredDb = openLibraryDatabase({ path: join(targetDir, 'library.db'), dbKey: restoredDbKey });
    assert.deepEqual(new PhotosRepository(restoredDb).manifestSnapshot(), repo.manifestSnapshot());
    restoredDb.close();
    const restoredStore = new BlobStore({ dataDir: targetDir });
    await restoredStore.init();
    assert.deepEqual(await buffer(restoredStore.getStream(ref.contentHash, restoredKeys.resolver(), 'P1')), plaintext);
    db.close();
  } finally {
    masterKey?.fill(0);
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});
