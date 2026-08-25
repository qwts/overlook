import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, test } from 'node:test';

import { buildBackupManifestV2, type BackupManifestV2 } from '../../src/main/backup/backup-manifest.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { ProviderError } from '../../src/main/backup/provider.js';
import { sealRecoveryBootstrap } from '../../src/main/backup/recovery-bootstrap.js';
import { discoverRestore } from '../../src/main/backup/restore-discovery.js';
import { RestoreError } from '../../src/main/backup/restore-types.js';
import { createEncryptStream } from '../../src/main/crypto/envelope.js';
import { KeyStore, type SafeStorageLike } from '../../src/main/crypto/keystore.js';

const LIBRARY_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const GENERATED_AT = '2026-07-14T23:00:00.000Z';
const HASH = 'ab'.repeat(32);

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => value.toString('utf8'),
};

function manifest(keyId: number): BackupManifestV2 {
  return buildBackupManifestV2({
    libraryId: LIBRARY_ID,
    generatedAt: GENERATED_AT,
    snapshot: {
      databaseSchema: 3,
      keyIds: [keyId],
      totals: { photos: 1, bytes: 42, albums: 0 },
      photos: [
        {
          id: 'P1',
          fileName: 'IMG_0001.JPG',
          fileKind: 'jpeg',
          mediaInfo: null,
          width: 10,
          height: 20,
          bytes: 42,
          contentHash: HASH,
          blobPath: `blobs/ab/${HASH}`,
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
          importedAt: GENERATED_AT,
          importSource: 'restore-test',
          favorite: false,
          keyId,
          deletedAt: null,
        },
      ],
      albums: [],
    },
  });
}

async function put(provider: MockProvider, path: string, bytes: Buffer): Promise<void> {
  await provider.put(path, Readable.from([bytes]));
}

async function sealManifest(value: unknown, keyStore: KeyStore): Promise<Buffer> {
  return buffer(
    Readable.from([Buffer.from(JSON.stringify(value))]).pipe(createEncryptStream(keyStore.currentKey(), { photoId: 'manifest' })),
  );
}

async function world(): Promise<{ provider: MockProvider; keyStore: KeyStore; masterKey: Buffer }> {
  const keyStore = KeyStore.open({ safeStorage: fakeSafeStorage, dataDir: mkdtempSync(join(tmpdir(), 'overlook-restore-keys-')) });
  const masterKey = keyStore.masterKeyBytes();
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-restore-remote-')) });
  await put(
    provider,
    'recovery/bootstrap.ovrb',
    sealRecoveryBootstrap({ schema: 1, libraryId: LIBRARY_ID, generatedAt: GENERATED_AT, keys: keyStore.exportWrappedKeys() }, masterKey),
  );
  return { provider, keyStore, masterKey };
}

async function putV2Bootstrap(
  value: Awaited<ReturnType<typeof world>>,
  manifestGeneration: number,
  generatedAt = GENERATED_AT,
): Promise<void> {
  await put(
    value.provider,
    'recovery/bootstrap.ovrb',
    sealRecoveryBootstrap(
      {
        schema: 2,
        libraryId: LIBRARY_ID,
        generatedAt,
        manifestGeneration,
        keys: value.keyStore.exportWrappedKeys(),
      },
      value.masterKey,
    ),
  );
}

describe('restore discovery (#288)', () => {
  test('newest corrupt manifest falls back to the retained valid generation', async () => {
    const w = await world();
    await put(w.provider, 'manifest/gen-1.ovlk', await sealManifest(manifest(1), w.keyStore));
    await put(w.provider, 'manifest/gen-2.ovlk', Buffer.from('corrupt'));

    const found = await discoverRestore(w.provider, w.masterKey);
    assert.equal(found.bootstrap.libraryId, LIBRARY_ID);
    assert.equal(found.newestGeneration, 2, 'the UI can report that generation 2 was rejected');
    assert.deepEqual(
      found.candidates.map((candidate) => candidate.generation),
      [1],
    );
    assert.equal(found.candidates[0]?.manifest.photos[0]?.id, 'P1');
  });

  test('a retryable newest manifest never falls back to a stale generation (#751 review)', async () => {
    const w = await world();
    await put(w.provider, 'manifest/gen-1.ovlk', await sealManifest(manifest(1), w.keyStore));
    await put(w.provider, 'manifest/gen-2.ovlk', await sealManifest(manifest(1), w.keyStore));
    const getStream = w.provider.getStream.bind(w.provider);
    const opened: string[] = [];
    w.provider.getStream = (path) => {
      opened.push(path);
      return path === 'manifest/gen-2.ovlk'
        ? Promise.reject(new ProviderError('manifest is still materializing', 'transient', 'object'))
        : getStream(path);
    };

    await assert.rejects(
      discoverRestore(w.provider, w.masterKey),
      (error: unknown) => error instanceof RestoreError && error.reason === 'io',
    );
    assert.deepEqual(opened, ['recovery/bootstrap.ovrb', 'manifest/gen-2.ovlk']);
  });

  test('an older v2 bootstrap replay fails before any manifest is decrypted (#996)', async () => {
    const w = await world();
    await put(w.provider, 'manifest/gen-1.ovlk', await sealManifest(manifest(1), w.keyStore));
    await put(w.provider, 'manifest/gen-2.ovlk', await sealManifest(manifest(1), w.keyStore));
    await putV2Bootstrap(w, 1);
    const getStream = w.provider.getStream.bind(w.provider);
    const opened: string[] = [];
    w.provider.getStream = (path) => {
      opened.push(path);
      return getStream(path);
    };

    await assert.rejects(
      discoverRestore(w.provider, w.masterKey),
      (error: unknown) => error instanceof RestoreError && error.reason === 'corrupt' && /predates/u.test(error.message),
    );
    assert.deepEqual(opened, ['recovery/bootstrap.ovrb']);
  });

  test('a v2 bootstrap one generation ahead preserves the prior manifest after interruption (#996)', async () => {
    const w = await world();
    await put(w.provider, 'manifest/gen-1.ovlk', await sealManifest(manifest(1), w.keyStore));
    await putV2Bootstrap(w, 2, '2025-01-01T00:00:00.000Z');

    const found = await discoverRestore(w.provider, w.masterKey);
    assert.equal(found.bootstrap.schema, 2);
    assert.deepEqual(
      found.candidates.map((candidate) => candidate.generation),
      [1],
    );
  });

  test('generation binding ignores rolled-back and identical wall-clock timestamps (#996)', async () => {
    const w = await world();
    const rolledBack = { ...manifest(1), generatedAt: '2025-01-01T00:00:00.000Z' };
    await put(w.provider, 'manifest/gen-1.ovlk', await sealManifest(manifest(1), w.keyStore));
    await put(w.provider, 'manifest/gen-2.ovlk', await sealManifest(rolledBack, w.keyStore));
    await putV2Bootstrap(w, 2, GENERATED_AT);

    const found = await discoverRestore(w.provider, w.masterKey);
    assert.deepEqual(
      found.candidates.map((candidate) => candidate.generation),
      [2, 1],
    );
  });

  test('a v2 bootstrap gap larger than the bootstrap-first window fails closed (#996)', async () => {
    const w = await world();
    await put(w.provider, 'manifest/gen-1.ovlk', await sealManifest(manifest(1), w.keyStore));
    await putV2Bootstrap(w, 3);

    await assert.rejects(
      discoverRestore(w.provider, w.masterKey),
      (error: unknown) => error instanceof RestoreError && error.reason === 'corrupt' && /not contiguous/u.test(error.message),
    );
  });

  test('a wrong recovery master fails before any manifest can be trusted', async () => {
    const w = await world();
    await put(w.provider, 'manifest/gen-1.ovlk', await sealManifest(manifest(1), w.keyStore));

    await assert.rejects(
      discoverRestore(w.provider, randomBytes(32)),
      (error: unknown) => error instanceof RestoreError && error.reason === 'wrong-key',
    );
  });

  test('a newest manifest encrypted after key rotation cannot fall back through a stale v1 bootstrap (#996)', async () => {
    const w = await world();
    await put(w.provider, 'manifest/gen-1.ovlk', await sealManifest(manifest(1), w.keyStore));
    const rotated = w.keyStore.rotate();
    await put(w.provider, 'manifest/gen-2.ovlk', await sealManifest(manifest(rotated.id), w.keyStore));

    await assert.rejects(
      discoverRestore(w.provider, w.masterKey),
      (error: unknown) => error instanceof RestoreError && error.reason === 'wrong-key' && /key 2 is unavailable/u.test(error.message),
    );
  });

  test('a missing key in a lower generation cannot override a newer valid candidate (#996)', async () => {
    const w = await world();
    await put(w.provider, 'manifest/gen-2.ovlk', await sealManifest(manifest(1), w.keyStore));
    const rotated = w.keyStore.rotate();
    await put(w.provider, 'manifest/gen-1.ovlk', await sealManifest(manifest(rotated.id), w.keyStore));

    const found = await discoverRestore(w.provider, w.masterKey);
    assert.deepEqual(
      found.candidates.map((candidate) => candidate.generation),
      [2],
    );
  });

  test('duplicate blob references invalidate a manifest generation', async () => {
    const w = await world();
    const source = manifest(1);
    const duplicate = {
      ...source,
      totals: { ...source.totals, photos: 2, bytes: 84 },
      photos: [...source.photos, { ...source.photos[0], id: 'P2' }],
    };
    await put(w.provider, 'manifest/gen-1.ovlk', await sealManifest(duplicate, w.keyStore));

    await assert.rejects(
      discoverRestore(w.provider, w.masterKey),
      (error: unknown) => error instanceof RestoreError && error.reason === 'corrupt',
    );
  });
});
