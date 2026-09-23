import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

import { BackupIntegrityScrubber, type BackupIntegrityCursor, type BackupIntegrityItem } from '../../src/main/backup/integrity-scrubber.js';
import { startLoopbackCapture } from '../../src/main/backup/pcloud/loopback.js';
import { buildAuthorizeUrl } from '../../src/main/backup/pcloud/oauth.js';
import { PCloudProvider } from '../../src/main/backup/pcloud/pcloud-provider.js';
import { ProviderError } from '../../src/main/backup/provider.js';
import { ulid } from '../../src/main/import/ulid.js';
import { exerciseDisasterRecoveryContract } from './disaster-recovery-contract.js';
import { exerciseRestoreProviderContract } from './restore-provider-contract.js';

// The LIVE half of #109's exit criteria (#256): the provider contract from
// #103 exercised against real pCloud. Env-gated and interactive — NEVER in
// CI. Run with `npm run test:pcloud:live`; the test prints an authorize URL,
// the owner approves in a browser, and the loopback captures the token (no
// manual token handling). Work happens under a unique
// /Overlook/<unique-ulid>/ home; files are deleted afterward (the
// empty scratch folders linger — folder removal isn't part of the provider
// interface, and each run's ULID keeps them inert).

const LIVE = process.env['OVERLOOK_PCLOUD_LIVE'] === '1';

test('LIVE pCloud provider and fresh-profile disaster-recovery contracts (#291)', { skip: !LIVE, timeout: 10 * 60_000 }, async () => {
  const state = randomBytes(16).toString('hex');
  const capture = startLoopbackCapture({ state, timeoutMs: 5 * 60_000 });
  await capture.listening;
  console.log('\n  ➜ Open this URL in your browser and approve pCloud access:\n');
  const clientId = process.env['OVERLOOK_PCLOUD_CLIENT_ID']?.trim() ?? '';
  assert.notEqual(clientId, '', 'set OVERLOOK_PCLOUD_CLIENT_ID to the public pCloud app identifier');
  console.log(`    ${buildAuthorizeUrl(state, clientId)}\n`);
  const auth = await capture.result;
  console.log(`  ✓ token captured (region host: ${auth.apiHost})\n`);

  const libraryId = ulid();
  const provider = new PCloudProvider({
    auth: () => ({ ...auth, connectedAt: new Date().toISOString() }),
    libraryId,
  });
  console.log(`  • isolated scratch home: /Overlook/${libraryId}\n`);

  const PAYLOAD = Buffer.from('OVLK-live-contract-payload');
  const blobPath = 'blobs/ab/abcdef123';
  await exerciseRestoreProviderContract(provider, libraryId);
  const recovered = await exerciseDisasterRecoveryContract(provider, libraryId);
  assert.deepEqual(recovered, { generation: 1, photos: 2 });
  try {
    const put = await provider.put(blobPath, Readable.from([PAYLOAD]));
    assert.equal(put.bytes, PAYLOAD.length, 'provider records the exact byte count');

    const listed = await provider.list('blobs');
    assert.deepEqual(listed, [{ path: blobPath, bytes: PAYLOAD.length }], 'listing mirrors the mock contract');

    const verified = await provider.verify(blobPath);
    assert.equal(verified.bytes, PAYLOAD.length);

    const quota = await provider.quota();
    assert.ok(quota.totalBytes !== null && quota.totalBytes > 0, 'quota reports the real plan size');
    assert.ok(quota.usedBytes >= 0 && quota.usedBytes <= quota.totalBytes);
  } finally {
    await provider.delete(blobPath);
  }

  const integrityBytes = Buffer.from('OVLK-live-integrity-ciphertext');
  const integrityHash = createHash('sha256').update(integrityBytes).digest('hex');
  const integrityPath = `blobs/${integrityHash.slice(0, 2)}/${integrityHash}`;
  let integrityItem: BackupIntegrityItem = { id: 'LIVE-P1', assetOwnerId: null, contentHash: integrityHash, syncState: 'synced' };
  let localExists = true;
  let cursor: BackupIntegrityCursor = { version: 1, afterId: null, completedAt: null };
  const marked: string[] = [];
  const scrubber = new BackupIntegrityScrubber({
    provider,
    batchSize: 10,
    items: () => [integrityItem],
    hasLocal: () => localExists,
    encryptedStream: () => Readable.from([integrityBytes]),
    verifyRemoteCiphertext: () => Promise.resolve(false),
    markUnrecoverable: (photoId) => marked.push(photoId),
    cursor: {
      load: () => Promise.resolve(cursor),
      save: (next) => {
        cursor = next;
        return Promise.resolve();
      },
    },
    audit: () => undefined,
    now: () => new Date(),
  });
  try {
    await provider.put(integrityPath, Readable.from([Buffer.from('corrupt remote ciphertext')]));
    assert.equal((await scrubber.scrub()).repaired, 1, 'pCloud corruption is replaced from local ciphertext');
    await provider.delete(integrityPath);
    integrityItem = { ...integrityItem, syncState: 'offloaded' };
    localExists = false;
    assert.equal((await scrubber.scrub()).unrecoverable, 1, 'missing pCloud-only ciphertext fails closed');
    assert.deepEqual(marked, ['LIVE-P1']);
  } finally {
    await provider.delete(integrityPath);
  }

  await assert.rejects(
    provider.getStream(blobPath),
    (error: unknown) => error instanceof ProviderError && error.kind === 'not-found',
    'deleted entries read as not-found',
  );
  await assert.rejects(
    provider.put('a/../b', Readable.from([PAYLOAD])),
    (error: unknown) => error instanceof ProviderError && error.kind === 'corrupt',
    'unsafe paths are rejected before any network',
  );
  console.log('  ✓ live provider + integrity + disaster-recovery contracts green — record this run on #291 and #302\n');
});
