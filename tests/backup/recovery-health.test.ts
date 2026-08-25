import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { buildBackupManifestV2 } from '../../src/main/backup/backup-manifest.js';
import { sealManifestJson } from '../../src/main/backup/manifest-sealer.js';
import { FaultInjectingProvider, MockProvider } from '../../src/main/backup/mock-provider.js';
import { recoveryGenerationHealthy } from '../../src/main/backup/recovery-health.js';
import { sealKeyStoreRecoveryBootstrap } from '../../src/main/backup/recovery-bootstrap.js';
import { RestoreError } from '../../src/main/backup/restore-types.js';
import { KeyStore, type SafeStorageLike } from '../../src/main/crypto/keystore.js';

const LIBRARY_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const GENERATED_AT = '2026-07-15T03:00:00.000Z';
const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => value.toString('utf8'),
};

async function recoveryWorld() {
  const keyStore = KeyStore.open({ safeStorage, dataDir: mkdtempSync(join(tmpdir(), 'overlook-recovery-health-keys-')) });
  const provider = new MockProvider({
    rootDir: mkdtempSync(join(tmpdir(), 'overlook-recovery-health-remote-')),
    libraryId: LIBRARY_ID,
  });
  const manifest = buildBackupManifestV2({
    libraryId: LIBRARY_ID,
    generatedAt: GENERATED_AT,
    snapshot: {
      databaseSchema: 4,
      keyIds: [],
      totals: { photos: 0, bytes: 0, albums: 0 },
      photos: [],
      albums: [],
    },
  });
  await provider.put(
    'recovery/bootstrap.ovrb',
    Readable.from([sealKeyStoreRecoveryBootstrap({ keyStore, libraryId: LIBRARY_ID, generatedAt: GENERATED_AT, manifestGeneration: 1 })]),
  );
  await provider.put('manifest/gen-1.ovlk', Readable.from([await sealManifestJson(JSON.stringify(manifest), keyStore.currentKey())]));
  return { keyStore, provider };
}

test('newest authenticated recovery generation is healthy; corruption is repair debt (#302)', async () => {
  const { keyStore, provider } = await recoveryWorld();
  const check = () => recoveryGenerationHealthy({ provider, libraryId: LIBRARY_ID, masterKeyBytes: () => keyStore.masterKeyBytes() });

  assert.equal(await check(), true);
  await provider.put('manifest/gen-1.ovlk', Readable.from([Buffer.from('corrupt manifest')]));
  assert.equal(await check(), false);
  await provider.delete('recovery/bootstrap.ovrb');
  assert.equal(await check(), false);
});

test('transient provider failures stay retryable instead of being classified as corruption', async () => {
  const { keyStore, provider } = await recoveryWorld();
  const faulty = new FaultInjectingProvider(provider);
  faulty.arm('transient-get');

  await assert.rejects(
    recoveryGenerationHealthy({ provider: faulty, libraryId: LIBRARY_ID, masterKeyBytes: () => keyStore.masterKeyBytes() }),
    (error: unknown) => error instanceof RestoreError && error.reason === 'offline',
  );
});
