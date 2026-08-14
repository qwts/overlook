import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { buildBackupManifestV2 } from '../../src/main/backup/backup-manifest.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { sealRecoveryBootstrap } from '../../src/main/backup/recovery-bootstrap.js';
import { RestoreRuntime } from '../../src/main/backup/restore-runtime.js';
import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { createEncryptStream } from '../../src/main/crypto/envelope.js';
import { KeyStore, type SafeStorageLike } from '../../src/main/crypto/keystore.js';
import { sampleJpeg } from '../../src/main/library/seed.js';

// #741: the runtime wires the coordinator's key sources — including the
// local-master path — without touching Electron, so the composition is
// coverable under node:test.

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => value.toString('utf8'),
};

function runtime(localMasterKey: (() => Buffer | null) | undefined): RestoreRuntime {
  return new RestoreRuntime({
    targetDir: mkdtempSync(join(tmpdir(), 'overlook-restore-runtime-')),
    workerUrl: new URL('file:///unused-thumbnail-worker.js'),
    safeStorage: () => fakeSafeStorage,
    localMasterKey,
    sources: () => Promise.resolve([]),
    sessionId: () => 'session-runtime',
    progress: () => undefined,
    beforeActivate: () => Promise.resolve(),
    workStarted: () => undefined,
    workFinished: () => undefined,
    activated: () => undefined,
  });
}

test('an absent local master key surfaces recovery-key guidance through the runtime (#741)', async () => {
  const r = runtime(() => null);
  const discovery = await r.coordinator.discoverFrom('pcloud', { kind: 'local-master' });
  assert.equal(discovery.sessionId, null);
  assert.equal(discovery.error?.reason, 'wrong-key');
  r.dispose();
  await r.close();
});

test('an unreadable recovery-key file fails discovery without a session', async () => {
  const r = runtime(undefined);
  const missingKey = join(mkdtempSync(join(tmpdir(), 'overlook-restore-key-')), 'absent.ovrk');
  const discovery = await r.coordinator.discover('pcloud', missingKey, 'password');
  assert.equal(discovery.sessionId, null);
  assert.notEqual(discovery.error, null);
  r.dispose();
  await r.close();
});

test('verify constructs the engine runner and scans without downloading originals (#994)', async () => {
  const libraryId = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
  const generatedAt = '2026-07-14T23:00:00.000Z';
  const sourceDir = mkdtempSync(join(tmpdir(), 'overlook-restore-runtime-source-'));
  const keyStore = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: sourceDir });
  const masterKey = keyStore.masterKeyBytes();
  const sourceStore = new BlobStore({ dataDir: sourceDir });
  await sourceStore.init();
  const bytes = sampleJpeg(1);
  const ref = await sourceStore.putOriginal(Readable.from([bytes]), keyStore.currentKey(), 'P1');
  const photo = {
    id: 'P1',
    fileName: 'IMG_1.JPG',
    fileKind: 'jpeg' as const,
    mediaInfo: null,
    width: 1,
    height: 1,
    bytes: ref.bytes,
    contentHash: ref.contentHash,
    blobPath: `blobs/${ref.contentHash.slice(0, 2)}/${ref.contentHash}`,
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
    importedAt: generatedAt,
    importSource: 'cloud-restore',
    favorite: false,
    keyId: ref.keyId,
    deletedAt: null,
  };
  const provider = new MockProvider({
    rootDir: mkdtempSync(join(tmpdir(), 'overlook-restore-runtime-remote-')),
    libraryId,
  });
  await provider.put(photo.blobPath, Readable.from([await buffer(sourceStore.getEncryptedStream(photo.contentHash))]));
  await provider.put(
    'recovery/bootstrap.ovrb',
    Readable.from([sealRecoveryBootstrap({ schema: 1, libraryId, generatedAt, keys: keyStore.exportWrappedKeys() }, masterKey)]),
  );
  await provider.put(
    'manifest/gen-1.ovlk',
    Readable.from([
      await buffer(
        Readable.from([
          Buffer.from(
            JSON.stringify(
              buildBackupManifestV2({
                libraryId,
                generatedAt,
                snapshot: {
                  databaseSchema: 3,
                  keyIds: [1],
                  totals: { photos: 1, bytes: photo.bytes, albums: 1 },
                  photos: [photo],
                  albums: [{ id: 'A1', name: 'Recovered', createdAt: generatedAt, position: 0, photoIds: ['P1'] }],
                },
              }),
            ),
          ),
        ]).pipe(createEncryptStream(keyStore.currentKey(), { photoId: 'manifest' })),
      ),
    ]),
  );
  const gets: string[] = [];
  const getStream = provider.getStream.bind(provider);
  provider.getStream = (path) => {
    gets.push(path);
    return getStream(path);
  };
  const r = new RestoreRuntime({
    targetDir: join(mkdtempSync(join(tmpdir(), 'overlook-restore-runtime-target-')), 'library'),
    workerUrl: new URL('file:///unused-thumbnail-worker.js'),
    safeStorage: () => fakeSafeStorage,
    localMasterKey: () => Buffer.from(masterKey),
    sources: () => Promise.resolve([{ libraryId, provider }]),
    sessionId: () => 'session-runtime-verify',
    progress: () => undefined,
    beforeActivate: () => Promise.resolve(),
    workStarted: () => undefined,
    workFinished: () => undefined,
    activated: () => undefined,
  });
  const discovered = await r.coordinator.discoverFrom('mock', { kind: 'local-master' });
  assert.equal(discovered.error, null);
  assert.ok(discovered.sessionId);
  const verified = await r.coordinator.verify(discovered.sessionId, libraryId);
  assert.equal(verified.error, null);
  assert.equal(verified.result?.verifiedCount, 1);
  assert.deepEqual(
    gets.filter((path) => path.startsWith('blobs/')),
    [],
  );
  await r.close();
});
