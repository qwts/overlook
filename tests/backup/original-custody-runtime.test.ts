import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { createOriginalCustodyRuntime } from '../../src/main/backup/original-custody-runtime.js';
import type { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import type { BlobStore } from '../../src/main/blobs/blob-store.js';
import type { PhotosRepository } from '../../src/main/db/photos-repository.js';
import type { CustodyAuthority } from '../../src/main/backup/custody-authority-repository.js';

test('original custody runtime composes offload and ephemeral policy around one provider (#306)', () => {
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-custody-runtime-')) });
  const authority: CustodyAuthority = {
    id: 1,
    providerId: 'mock',
    accountId: 'mock-account',
    accountLabel: 'Mock account',
    remoteRoot: '/Overlook/mock-library/',
    state: 'bound',
    createdAt: '2026-08-06T00:00:00.000Z',
    lastVerifiedAt: null,
  };
  const statuses = new Map([['P0', 'offloaded' as const]]);
  const runtime = createOriginalCustodyRuntime({
    provider,
    connected: () => true,
    offloadAuthority: () => Promise.resolve(1),
    custody: { resolve: () => Promise.resolve({ authority, provider }) },
    custodyStatus: () =>
      Promise.resolve({
        state: 'available',
        providerId: 'mock',
        providerLabel: 'Local mock',
        accountLabel: 'Mock account',
      }),
    custodyChanged: () => undefined,
    ledger: {
      status: (photoId: string) => statuses.get(photoId),
      setStatus: () => undefined,
      isDirty: () => false,
    } as unknown as SyncLedger,
    repo: {
      get: () => undefined,
      countByContentHash: () => 1,
      offloadedPhotoIds: () => ['P0'],
    } as unknown as PhotosRepository,
    blobs: {} as BlobStore,
    blobsReady: Promise.resolve(),
    resolveKey: () => undefined,
    reOffloadAfterViewing: () => true,
    workChanged: () => undefined,
    syncStateChanged: () => undefined,
    storageChanged: () => undefined,
    stateChanged: () => undefined,
    invalidateFull: () => undefined,
    audit: () => undefined,
  });

  assert.equal(runtime.offload.status('P0'), 'offloaded');
  assert.deepEqual(runtime.ephemeral.stats(), { cachedBytes: 0, entries: 0, inFlight: 0 });
});
