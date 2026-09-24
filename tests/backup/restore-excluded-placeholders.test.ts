import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';

import { buildBackupManifestV14 } from '../../src/main/backup/backup-manifest.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { sealRecoveryBootstrap } from '../../src/main/backup/recovery-bootstrap.js';
import { RestoreEngine } from '../../src/main/backup/restore-engine.js';
import { sampleJpeg } from '../../src/main/library/seed.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { createEncryptStream } from '../../src/main/crypto/envelope.js';
import { KeyStore, type SafeStorageLike } from '../../src/main/crypto/keystore.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { queryGet, run } from '../../src/main/db/sql.js';
import { OriginalAvailabilityRepository } from '../../src/main/db/original-availability.js';

const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
};
const LIBRARY_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const AT = '2026-09-22T00:00:00.000Z';

for (const mode of ['excluded-only', 'mixed', 'missing-included'] as const) {
  test(`restore preserves excluded placeholders without requiring their bytes: ${mode} (#1233)`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'overlook-restore-exclusions-'));
    const keys = KeyStore.open({ safeStorage, dataDir: join(root, 'source') });
    const dbKey = keys.resolver()(1);
    assert.ok(dbKey !== undefined);
    const db = openLibraryDatabase({ path: join(root, 'source', 'library.db'), dbKey });
    run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', ?)`, [AT]);
    const photos = new PhotosRepository(db);
    const excludedPhoto = {
      id: 'P1',
      fileName: 'local-only.jpg',
      fileKind: 'jpeg' as const,
      width: 30,
      height: 20,
      bytes: 2048,
      contentHash: 'a'.repeat(64),
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
      importSource: 'camera',
      keyId: 1,
    };
    photos.insert(excludedPhoto);
    const includedBytes = sampleJpeg(1);
    const includedHash = createHash('sha256').update(includedBytes).digest('hex');
    if (mode !== 'excluded-only') photos.insert({ ...excludedPhoto, id: 'P2', contentHash: includedHash, bytes: includedBytes.length });
    const ledger = new SyncLedger(db);
    ledger.markExcluding('P1', 'user', AT);
    ledger.markExcluded('P1');
    assert.equal(
      queryGet<{ origin: string | null }>(db, 'SELECT restored_exclusion_at AS origin FROM photos WHERE id = @id', { id: 'P1' })?.origin,
      null,
    );
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
    const provider = new MockProvider({ rootDir: join(root, 'remote'), libraryId: LIBRARY_ID });
    const masterKey = keys.masterKeyBytes();
    if (mode === 'mixed') {
      const encrypted = await buffer(Readable.from([includedBytes]).pipe(createEncryptStream(keys.currentKey(), { photoId: 'P2' })));
      await provider.put(`blobs/${includedHash.slice(0, 2)}/${includedHash}`, Readable.from([encrypted]));
    }
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
          assert.equal(request.photoId, 'P2', 'excluded placeholders must not enter pixel generation');
          for (const kind of ['thumb', 'mid'] as const)
            await store.putThumb(Readable.from([includedBytes]), request.key, request.photoId, request.contentHash, kind);
          return { generated: true, width: 30, height: 20 };
        },
      }),
      events: { progress: () => undefined },
    });
    const verification = await engine.verify({ masterKey, allowReplace: false });
    const recoveredCount = mode === 'mixed' ? 1 : 0;
    const missingCount = mode === 'missing-included' ? 1 : 0;
    assert.equal(verification.verifiedCount, recoveredCount, 'placeholders are never counted as verified originals');
    assert.equal(verification.missingCount, missingCount);
    const result = await engine.run({ masterKey, allowReplace: false });
    assert.equal(result.photos, recoveredCount, 'placeholders are not recovered photo bytes');
    assert.equal(result.missing.length, missingCount, 'a missing included original stays a failure');
    if (missingCount > 0) assert.equal(result.missing[0]?.photoId, 'P2');
    const restoredKeys = KeyStore.open({ safeStorage, dataDir: targetDir });
    const restoredDbKey = restoredKeys.resolver()(1);
    assert.ok(restoredDbKey !== undefined);
    const restoredDb = openLibraryDatabase({ path: join(targetDir, 'library.db'), dbKey: restoredDbKey });
    assert.equal(new PhotosRepository(restoredDb).get('P1')?.coverage, 'excluded', 'keep the placeholder by default');
    assert.equal(new PhotosRepository(restoredDb).get('P2') !== undefined, mode === 'mixed');
    const origin = () =>
      queryGet<{ value: string | null }>(restoredDb, "SELECT restored_exclusion_at AS value FROM photos WHERE id = 'P1'")?.value;
    assert.equal(origin(), AT, 'restore records the excluded placeholder origin');
    const availability = new OriginalAvailabilityRepository(restoredDb);
    availability.repair('P1', 'error');
    assert.equal(origin(), AT, 'an error does not erase restore provenance');
    availability.verifiedRestored(excludedPhoto.contentHash);
    assert.equal(origin(), null, 'verified return of the original ends placeholder status');
    availability.repair('P1', 'error');
    assert.equal(origin(), null, 'later loss must not resurrect the restored exclusion marker');
    restoredDb.close();
    db.close();
    restoredKeys.close();
    keys.close();
  });
}
