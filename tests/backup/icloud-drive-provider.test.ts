import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, test } from 'node:test';

import { DeterministicICloudDriveBridge } from '../../src/main/backup/icloud-drive/deterministic-bridge.js';
import { ICloudDriveProvider } from '../../src/main/backup/icloud-drive/icloud-drive-provider.js';
import { ProviderError } from '../../src/main/backup/provider.js';
import { ulid } from '../../src/main/import/ulid.js';
import { exerciseDisasterRecoveryContract } from './disaster-recovery-contract.js';
import { exerciseObjectProviderContract } from './object-provider-contract.js';
import { exerciseProviderAccountContract } from './provider-account-contract.js';
import { exerciseRestoreProviderContract } from './restore-provider-contract.js';

const LIBRARY_ID = '01KXICLOUDDRIVELIBRARY001';
const UNRELATED_LIBRARY_ID = '01KXICLOUDDRIVEUNRELATED1';
const DELAYED_LIBRARY_ID = '01KXICLOUDDRIVEDELAYED001';
const CONFLICTED_LIBRARY_ID = '01KXICLOUDDRIVECONFLICT01';
const PAYLOAD = Buffer.from('OVLK-encrypted-iCloud-envelope');

function world(pageSize = 1) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'overlook-icloud-provider-'));
  const bridge = new DeterministicICloudDriveBridge();
  const provider = new ICloudDriveProvider({ bridge, libraryId: LIBRARY_ID, temporaryRoot, pageSize });
  return { bridge, provider, temporaryRoot };
}

function providerError(kind: ProviderError['kind']): (error: unknown) => boolean {
  return (error) => error instanceof ProviderError && error.kind === kind;
}

describe('iCloud Drive StorageProvider adapter (#657)', () => {
  test('captures the pinned account subject, detects replacement, and rejects unavailable identity', async () => {
    const state = world();
    try {
      await exerciseProviderAccountContract(state.provider, {
        accountId: '0123456789abcdef',
        accountLabel: 'Deterministic iCloud account',
      });
      state.bridge.changeAccount();
      assert.deepEqual(await state.provider.accountIdentity(), {
        accountId: 'fedcba9876543210',
        accountLabel: 'Deterministic iCloud account',
      });
      state.bridge.setAvailable(false);
      await assert.rejects(state.provider.accountIdentity(), providerError('transient'));
    } finally {
      rmSync(state.temporaryRoot, { recursive: true, force: true });
    }
  });

  test('satisfies shared object, restore, and complete disaster-recovery contracts', async () => {
    const state = world();
    try {
      assert.deepEqual(state.provider.capabilities, {
        quota: 'unknown',
        verification: 'download-hash',
        resumableUpload: false,
        platforms: ['darwin'],
        interactiveAuth: false,
        reconnectRequired: false,
        accountIdentity: 'stable-subject',
      });
      await exerciseObjectProviderContract(state.provider, LIBRARY_ID);
      await exerciseRestoreProviderContract(state.provider, LIBRARY_ID);
      await exerciseDisasterRecoveryContract(state.provider, ulid());
      assert.deepEqual(await state.provider.listLibraries(), []);
    } finally {
      rmSync(state.temporaryRoot, { recursive: true, force: true });
    }
  });

  test('shared object contract preserves an unrelated discovered library', async () => {
    const state = world();
    const unrelated = state.provider.forLibrary(UNRELATED_LIBRARY_ID);
    try {
      await unrelated.put('recovery/bootstrap.ovrb', Readable.from([PAYLOAD]));
      await exerciseObjectProviderContract(state.provider, LIBRARY_ID);
      assert.deepEqual(await state.provider.listLibraries(), [UNRELATED_LIBRARY_ID]);
    } finally {
      await unrelated.delete('recovery/bootstrap.ovrb');
      rmSync(state.temporaryRoot, { recursive: true, force: true });
    }
  });

  test('replaces atomically, paginates, scopes paths, hashes downloads, and reports unknown quota', async () => {
    const state = world();
    try {
      await state.provider.put('blobs/aa/one', Readable.from([Buffer.from('first')]));
      await state.provider.put('blobs/aa/one', Readable.from([PAYLOAD]));
      await state.provider.put('blobs/bb/two', Readable.from([Buffer.from('second')]));
      assert.deepEqual(await state.provider.list('blobs'), [
        { path: 'blobs/aa/one', bytes: PAYLOAD.length },
        { path: 'blobs/bb/two', bytes: 6 },
      ]);
      assert.ok(state.bridge.calls.includes(`list:Overlook/${LIBRARY_ID}/blobs:1`), 'provider follows the native cursor');
      assert.deepEqual(await buffer(await state.provider.getStream('blobs/aa/one')), PAYLOAD);
      assert.deepEqual(await state.provider.verify('blobs/aa/one'), {
        sha256: createHash('sha256').update(PAYLOAD).digest('hex'),
        bytes: PAYLOAD.length,
      });
      assert.deepEqual(await state.provider.quota(), { usedBytes: 0, totalBytes: null });
      assert.equal(state.provider.forLibrary('OTHER_LIBRARY').id, 'icloud-drive');
      assert.throws(() => state.provider.forLibrary('../escape'), providerError('corrupt'));
      assert.throws(() => new ICloudDriveProvider({ bridge: state.bridge, libraryId: LIBRARY_ID, pageSize: 0 }), providerError('corrupt'));
    } finally {
      rmSync(state.temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe('iCloud Drive deterministic failure contracts (#657)', () => {
  test('enumerates recovery homes without serial materialization and prioritizes locally readable candidates (#751)', async () => {
    const state = world();
    const delayed = state.provider.forLibrary(DELAYED_LIBRARY_ID);
    const conflicted = state.provider.forLibrary(CONFLICTED_LIBRARY_ID);
    try {
      await state.provider.put('blobs/aa/not-a-home', Readable.from([PAYLOAD]));
      assert.deepEqual(await state.provider.listLibraries(), []);
      await state.provider.put('recovery/bootstrap.ovrb', Readable.from([PAYLOAD]));
      await delayed.put('recovery/bootstrap.ovrb', Readable.from([PAYLOAD]));
      await conflicted.put('recovery/bootstrap.ovrb', Readable.from([PAYLOAD]));
      state.bridge.setDownloaded(`Overlook/${DELAYED_LIBRARY_ID}/recovery/bootstrap.ovrb`, false);
      state.bridge.setConflicted(`Overlook/${CONFLICTED_LIBRARY_ID}/recovery/bootstrap.ovrb`, true);
      state.bridge.calls.length = 0;

      assert.deepEqual(await state.provider.listLibraries(), [LIBRARY_ID, CONFLICTED_LIBRARY_ID, DELAYED_LIBRARY_ID]);
      assert.equal(
        state.bridge.calls.some((call) => call.startsWith('materialize:')),
        false,
        'candidate enumeration never waits for every bootstrap to materialize',
      );
    } finally {
      rmSync(state.temporaryRoot, { recursive: true, force: true });
    }
  });

  test('maps offline, delayed materialization, conflicts, unavailable accounts, and account replacement', async () => {
    const state = world();
    try {
      await state.provider.put('blobs/aa/object', Readable.from([PAYLOAD]));
      for (const fault of ['offline', 'materialization-delayed', 'conflict'] as const) {
        state.bridge.arm(fault);
        await assert.rejects(
          state.provider.verify('blobs/aa/object'),
          (error: unknown) =>
            providerError('transient')(error) &&
            error instanceof ProviderError &&
            error.scope === (fault === 'offline' ? 'provider' : 'object'),
        );
        state.bridge.disarm();
      }

      state.bridge.changeAccount();
      assert.equal(await state.provider.authState(), 'expired');
      await assert.rejects(state.provider.getStream('blobs/aa/object'), providerError('auth'));

      const fresh = new ICloudDriveProvider({ bridge: state.bridge, libraryId: LIBRARY_ID, temporaryRoot: state.temporaryRoot });
      assert.equal(await fresh.authState(), 'connected');
      state.bridge.setAvailable(false);
      assert.equal(await fresh.authState(), 'expired');
      await assert.rejects(fresh.quota(), providerError('auth'));
    } finally {
      rmSync(state.temporaryRoot, { recursive: true, force: true });
    }
  });

  test('scopes a conflicted listed entry to its library namespace (#751 review)', async () => {
    const state = world();
    try {
      await state.provider.put('manifest/gen-1.ovlk', Readable.from([PAYLOAD]));
      state.bridge.setConflicted(`Overlook/${LIBRARY_ID}/manifest/gen-1.ovlk`, true);
      await assert.rejects(
        state.provider.list('manifest'),
        (error: unknown) => error instanceof ProviderError && error.kind === 'transient' && error.scope === 'object',
      );
    } finally {
      rmSync(state.temporaryRoot, { recursive: true, force: true });
    }
  });

  test('rejects a replacement that leaves a conflicted iCloud version', async () => {
    const state = world();
    try {
      state.bridge.arm('conflict');
      await assert.rejects(state.provider.put('blobs/aa/conflicted', Readable.from([PAYLOAD])), providerError('transient'));
      state.bridge.disarm();
      await assert.rejects(state.provider.verify('blobs/aa/conflicted'), providerError('transient'));
    } finally {
      rmSync(state.temporaryRoot, { recursive: true, force: true });
    }
  });

  test('never reports interrupted or cancelled replacement as verified and survives provider restart', async () => {
    const state = world();
    try {
      state.bridge.arm('interrupt-after-replace');
      await assert.rejects(state.provider.put('blobs/aa/interrupted', Readable.from([PAYLOAD])), providerError('transient'));
      state.bridge.disarm();
      const restarted = new ICloudDriveProvider({
        bridge: state.bridge,
        libraryId: LIBRARY_ID,
        temporaryRoot: state.temporaryRoot,
      });
      assert.deepEqual(await restarted.verify('blobs/aa/interrupted'), {
        sha256: createHash('sha256').update(PAYLOAD).digest('hex'),
        bytes: PAYLOAD.length,
      });

      const cancelled = Readable.from(
        (function* () {
          yield Buffer.from('partial');
          throw new Error('cancelled');
        })(),
      );
      await assert.rejects(restarted.put('blobs/aa/cancelled', cancelled), providerError('transient'));
      assert.equal(state.bridge.objects.has(`Overlook/${LIBRARY_ID}/blobs/aa/cancelled`), false);
      await restarted.delete('blobs/aa/missing');
    } finally {
      rmSync(state.temporaryRoot, { recursive: true, force: true });
    }
  });
});
