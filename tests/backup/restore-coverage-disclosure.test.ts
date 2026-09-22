import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';

import { buildBackupManifestV14 } from '../../src/main/backup/backup-manifest.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { sealRecoveryBootstrap } from '../../src/main/backup/recovery-bootstrap.js';
import { RestoreCoordinator } from '../../src/main/backup/restore-coordinator.js';
import { RestoreEngine } from '../../src/main/backup/restore-engine.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { createEncryptStream } from '../../src/main/crypto/envelope.js';
import { KeyStore, type SafeStorageLike } from '../../src/main/crypto/keystore.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';

const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
};
const LIBRARY_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const AT = '2026-09-22T00:00:00.000Z';

test('restore discloses deliberate exclusions and retains a report without missing objects (#1125)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'overlook-restore-exclusions-'));
  const keys = KeyStore.open({ safeStorage, dataDir: join(root, 'source') });
  const dbKey = keys.resolver()(1);
  assert.ok(dbKey !== undefined);
  const db = openLibraryDatabase({ path: join(root, 'source', 'library.db'), dbKey });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', ?)`, [AT]);
  const photos = new PhotosRepository(db);
  photos.insert({
    id: 'P1',
    fileName: 'local-only.jpg',
    fileKind: 'jpeg',
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
  });
  const ledger = new SyncLedger(db);
  ledger.markExcluding('P1', 'user', AT);
  ledger.markExcluded('P1');
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
    thumbnails: () => ({
      generateFor: () => {
        throw new Error('an excluded photo has no bytes to decode');
      },
    }),
    events: { progress: () => undefined },
  });
  const coordinator = new RestoreCoordinator({
    localMasterKey: () => Buffer.from(masterKey),
    readRecoveryKey: () => Promise.reject(new Error('local master key supplied')),
    sources: () => Promise.resolve([{ libraryId: LIBRARY_ID, provider }]),
    createRunner: () => engine,
    sessionId: () => 'exclusion-session',
    progress: () => undefined,
  });
  const discovered = await coordinator.discoverFrom('mock', { kind: 'local-master' });
  assert.equal(discovered.error, null);
  assert.equal(discovered.libraries[0]?.excludedCount, 1);
  assert.equal(discovered.libraries[0]?.excludedBytes, 2048);
  const sessionId = discovered.sessionId;
  assert.ok(sessionId !== null);
  const verified = await coordinator.verify(sessionId, LIBRARY_ID);
  assert.ok(verified.result !== null);
  assert.deepEqual(verified.result.coverage, { excludedCount: 1, excludedBytes: 2048 });
  assert.deepEqual(coordinator.status().verification?.coverage, verified.result.coverage);
  const response = await coordinator.run(sessionId, LIBRARY_ID, verified.result.verificationId, false);
  assert.equal(response.error, null);
  const result = response.result;
  assert.ok(result !== null);
  assert.deepEqual(result.coverage, { excludedCount: 1, excludedBytes: 2048 });
  assert.deepEqual(coordinator.status().lastResult?.coverage, result.coverage);
  assert.deepEqual(result.missing, [], 'deliberate exclusions are not missing-object failures');
  const report = JSON.parse(await readFile(join(targetDir, 'restore-report.json'), 'utf8')) as {
    generation: number;
    coverage: { excludedCount: number; excludedBytes: number };
    missing: unknown[];
  };
  assert.equal(report.generation, 1);
  assert.deepEqual(report.coverage, { excludedCount: 1, excludedBytes: 2048 });
  assert.deepEqual(report.missing, []);
  const restoredKeys = KeyStore.open({ safeStorage, dataDir: targetDir });
  const restoredDbKey = restoredKeys.resolver()(1);
  assert.ok(restoredDbKey !== undefined);
  const restoredDb = openLibraryDatabase({ path: join(targetDir, 'library.db'), dbKey: restoredDbKey });
  assert.equal(new PhotosRepository(restoredDb).get('P1')?.coverage, 'excluded', 'keep the placeholder by default');
  restoredDb.close();
  db.close();
  restoredKeys.close();
  keys.close();
});
