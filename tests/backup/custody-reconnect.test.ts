import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import { CustodyAuthorityRepository } from '../../src/main/backup/custody-authority-repository.js';
import { createActiveProvider } from '../../src/main/backup/active-provider.js';
import { verifyCustodyReconnect } from '../../src/main/backup/custody-reconnect.js';
import { createCustodyRoutingRuntime } from '../../src/main/backup/custody-routing-runtime.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import type { ProviderAccountIdentity } from '../../src/main/backup/provider.js';
import { sealRecoveryBootstrap } from '../../src/main/backup/recovery-bootstrap.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { queryGet, run } from '../../src/main/db/sql.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

const LIBRARY_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ROOT = `/Overlook/${LIBRARY_ID}/`;
const VERIFIED_AT = '2026-08-06T21:45:00.000Z';

function photo(id: string): PhotoInsert {
  return {
    id,
    fileName: `${id}.jpg`,
    fileKind: 'jpeg',
    width: 1,
    height: 1,
    bytes: 10,
    contentHash: (id === 'P1' ? 'ab' : 'cd').repeat(32),
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
    importedAt: '2026-08-06T00:00:00.000Z',
    importSource: 'test',
    keyId: 1,
  } satisfies PhotoInsert;
}

function world() {
  const path = join(mkdtempSync(join(tmpdir(), 'overlook-custody-reconnect-')), 'library.db');
  const dbKey = randomBytes(32);
  const db = openLibraryDatabase({ path, dbKey });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-08-06T00:00:00.000Z')`);
  const photos = new PhotosRepository(db);
  photos.insert(photo('P1'));
  const ledger = new SyncLedger(db);
  ledger.setStatus('P1', 'syncing');
  ledger.markBackedUp('P1', '2026-08-06T00:01:00.000Z');
  const authorities = new CustodyAuthorityRepository(db);
  const authority = authorities.create({
    providerId: 'mock',
    accountId: 'account-a',
    accountLabel: 'Account A',
    remoteRoot: ROOT,
    createdAt: '2026-08-06T00:02:00.000Z',
  });
  ledger.markOffloaded('P1', authority.id);
  authorities.markProviderRequired('mock', 'account-a');
  const masterKey = randomBytes(32);
  const provider = new MockProvider({
    rootDir: mkdtempSync(join(tmpdir(), 'overlook-custody-reconnect-remote-')),
    libraryId: LIBRARY_ID,
    accountIdentity: { accountId: 'account-a', accountLabel: 'Account A' },
  });
  return { path, dbKey, db, photos, ledger, authorities, authority, masterKey, provider };
}

async function putBootstrap(provider: MockProvider, masterKey: Buffer, libraryId = LIBRARY_ID): Promise<void> {
  const sealed = sealRecoveryBootstrap(
    {
      schema: 1,
      libraryId,
      generatedAt: '2026-08-06T21:40:00.000Z',
      keys: [
        {
          id: 1,
          createdAt: '2026-08-06T00:00:00.000Z',
          status: 'active',
          wrappedKey: randomBytes(60).toString('base64'),
        },
      ],
    },
    masterKey,
  );
  await provider.put('recovery/bootstrap.ovrb', Readable.from([sealed]));
}

async function waitFor(predicate: () => boolean, failure: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(failure);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe('custody reconnect verification (#733)', () => {
  test('same account plus authenticated namespace restores binding without a ledger transition and survives restart', async () => {
    const w = world();
    await putBootstrap(w.provider, w.masterKey);
    let changed = 0;
    assert.deepEqual(
      await verifyCustodyReconnect(
        {
          authorities: w.authorities,
          libraryId: () => LIBRARY_ID,
          masterKey: () => Buffer.from(w.masterKey),
          now: () => VERIFIED_AT,
          custodyChanged: () => {
            changed += 1;
            throw new Error('registry temporarily unwritable');
          },
        },
        { provider: w.provider, identity: await w.provider.accountIdentity() },
      ),
      { ok: true },
    );
    assert.equal(w.ledger.status('P1'), 'offloaded', 'reconnect never fabricates a ledger transition');
    assert.deepEqual(w.authorities.get(w.authority.id), {
      ...w.authority,
      state: 'bound',
      lastVerifiedAt: VERIFIED_AT,
    });
    assert.equal(changed, 1);

    w.db.close();
    const reopened = openLibraryDatabase({ path: w.path, dbKey: w.dbKey });
    assert.equal(new CustodyAuthorityRepository(reopened).get(w.authority.id)?.lastVerifiedAt, VERIFIED_AT);
    reopened.close();
  });

  test('a different account remains only the selected backup target and never overwrites the old binding', async () => {
    const w = world();
    w.provider.setAccountIdentity({ accountId: 'account-b', accountLabel: 'Account B' });
    const result = await verifyCustodyReconnect(
      {
        authorities: w.authorities,
        libraryId: () => LIBRARY_ID,
        masterKey: () => Buffer.from(w.masterKey),
        now: () => VERIFIED_AT,
      },
      { provider: w.provider, identity: await w.provider.accountIdentity() },
    );
    assert.deepEqual(result, { ok: false, reason: 'wrong-account' });
    assert.equal(w.authorities.get(w.authority.id)?.state, 'provider-required');
    assert.equal(w.authorities.find('mock', 'account-b', ROOT), undefined);
    assert.equal(w.ledger.status('P1'), 'offloaded');
    w.db.close();
  });

  test('a wrong library bootstrap leaves the exact authority unavailable', async () => {
    const w = world();
    await putBootstrap(w.provider, w.masterKey, '01ARZ3NDEKTSV4RRFFQ69G5FAW');
    assert.deepEqual(
      await verifyCustodyReconnect(
        {
          authorities: w.authorities,
          libraryId: () => LIBRARY_ID,
          masterKey: () => Buffer.from(w.masterKey),
          now: () => VERIFIED_AT,
        },
        { provider: w.provider, identity: await w.provider.accountIdentity() },
      ),
      { ok: false, reason: 'unavailable' },
    );
    assert.equal(w.authorities.get(w.authority.id)?.state, 'provider-required');
    assert.equal(w.authorities.get(w.authority.id)?.lastVerifiedAt, null);
    w.db.close();
  });
});

test('custody status distinguishes provider-required and legacy-unbound originals (#734)', async () => {
  const w = world();
  const routing = createCustodyRoutingRuntime({
    db: w.db,
    backupTarget: w.provider,
    libraryId: () => LIBRARY_ID,
    provider: () => undefined,
    backupTargetConnected: () => false,
    status: (photoId) => w.ledger.status(photoId),
    now: () => VERIFIED_AT,
    masterKey: () => Buffer.from(w.masterKey),
  });

  assert.deepEqual(await routing.custodyStatus('P1'), {
    state: 'provider-required',
    providerId: 'mock',
    providerLabel: 'mock',
    accountLabel: 'Account A',
  });
  run(w.db, `UPDATE sync_ledger SET custody_authority_id = NULL WHERE photo_id = 'P1'`);
  assert.deepEqual(await routing.custodyStatus('P1'), {
    state: 'legacy-unbound',
    providerId: null,
    providerLabel: null,
    accountLabel: null,
  });
  await routing.close();
  w.db.close();
});

test('an account change during namespace proof cannot bind the earlier subject (#733)', async () => {
  const w = world();
  await putBootstrap(w.provider, w.masterKey);
  const getStream = w.provider.getStream.bind(w.provider);
  w.provider.getStream = async (path) => {
    const stream = await getStream(path);
    w.provider.setAccountIdentity({ accountId: 'account-b', accountLabel: 'Account B' });
    return stream;
  };

  assert.deepEqual(
    await verifyCustodyReconnect(
      {
        authorities: w.authorities,
        libraryId: () => LIBRARY_ID,
        masterKey: () => Buffer.from(w.masterKey),
        now: () => VERIFIED_AT,
      },
      { provider: w.provider, identity: { accountId: 'account-a', accountLabel: 'Account A' } },
    ),
    {
      ok: false,
      reason: 'wrong-account',
      replacementIdentity: { accountId: 'account-b', accountLabel: 'Account B' },
    },
  );
  assert.equal(w.authorities.get(w.authority.id)?.state, 'provider-required');
  assert.equal(w.authorities.get(w.authority.id)?.lastVerifiedAt, null);
  w.db.close();
});

test('startup reconnect persists a replacement subject before completing the proof (#733)', async () => {
  const w = world();
  await putBootstrap(w.provider, w.masterKey);
  const getStream = w.provider.getStream.bind(w.provider);
  w.provider.getStream = async (path) => {
    const stream = await getStream(path);
    w.provider.setAccountIdentity({ accountId: 'account-b', accountLabel: 'Account B' });
    return stream;
  };
  let persistIdentity: ((identity: ProviderAccountIdentity) => void) | undefined;
  const persisted = new Promise<ProviderAccountIdentity>((resolve) => {
    persistIdentity = resolve;
  });
  const routing = createCustodyRoutingRuntime({
    db: w.db,
    backupTarget: w.provider,
    libraryId: () => LIBRARY_ID,
    provider: (providerId) => (providerId === w.provider.id ? w.provider : undefined),
    backupTargetConnected: () => true,
    status: (photoId) => w.ledger.status(photoId),
    now: () => VERIFIED_AT,
    masterKey: () => Buffer.from(w.masterKey),
    persistAccountIdentity: (_providerId, identity) => {
      persistIdentity?.(identity);
      return true;
    },
  });

  assert.deepEqual(await persisted, { accountId: 'account-b', accountLabel: 'Account B' });
  assert.equal(w.authorities.get(w.authority.id)?.state, 'provider-required');
  await routing.close();
  w.db.close();
});

test('the first post-upgrade scrub proves the namespace before offering a legacy authority (#733)', async () => {
  const w = world();
  run(w.db, `UPDATE sync_ledger SET custody_authority_id = NULL WHERE photo_id = 'P1'`);
  run(w.db, `DELETE FROM custody_authorities`);
  await putBootstrap(w.provider, w.masterKey);
  const routing = createCustodyRoutingRuntime({
    db: w.db,
    backupTarget: w.provider,
    libraryId: () => LIBRARY_ID,
    provider: (providerId) => (providerId === w.provider.id ? w.provider : undefined),
    backupTargetConnected: () => true,
    status: (photoId) => w.ledger.status(photoId),
    now: () => VERIFIED_AT,
    masterKey: () => Buffer.from(w.masterKey),
  });

  const handle = await routing.integrity.legacyAuthority();
  assert.equal(handle?.authority.accountId, 'account-a');
  assert.equal(handle?.authority.lastVerifiedAt, VERIFIED_AT);
  assert.equal(handle?.authority.state, 'bound');
  assert.deepEqual(w.authorities.legacyUnboundCount(), { items: 1, bytes: 10 });
  w.db.close();
});

test('legacy reconciliation can prove a second account without restoring the first account authority (#733)', async () => {
  const w = world();
  w.photos.insert(photo('P2'));
  w.ledger.setStatus('P2', 'syncing');
  w.ledger.markBackedUp('P2', '2026-08-06T00:03:00.000Z');
  w.ledger.setStatus('P2', 'offloaded');
  w.provider.setAccountIdentity({ accountId: 'account-b', accountLabel: 'Account B' });
  await putBootstrap(w.provider, w.masterKey);

  assert.deepEqual(
    await verifyCustodyReconnect(
      {
        authorities: w.authorities,
        libraryId: () => LIBRARY_ID,
        masterKey: () => Buffer.from(w.masterKey),
        now: () => VERIFIED_AT,
      },
      { provider: w.provider, identity: await w.provider.accountIdentity() },
    ),
    { ok: false, reason: 'wrong-account' },
  );
  assert.equal(w.authorities.get(w.authority.id)?.state, 'provider-required');
  assert.deepEqual(w.authorities.verified('mock', 'account-b', ROOT), {
    id: 2,
    providerId: 'mock',
    accountId: 'account-b',
    accountLabel: 'Account B',
    remoteRoot: ROOT,
    state: 'bound',
    createdAt: VERIFIED_AT,
    lastVerifiedAt: VERIFIED_AT,
  });
  const routing = createCustodyRoutingRuntime({
    db: w.db,
    backupTarget: w.provider,
    libraryId: () => LIBRARY_ID,
    provider: (providerId) => (providerId === w.provider.id ? w.provider : undefined),
    backupTargetConnected: () => true,
    status: (photoId) => w.ledger.status(photoId),
    now: () => VERIFIED_AT,
    masterKey: () => Buffer.from(w.masterKey),
  });
  const legacy = await routing.integrity.legacyAuthority();
  assert.equal(legacy?.authority.accountId, 'account-b');
  assert.equal(w.authorities.get(w.authority.id)?.state, 'provider-required');
  await routing.close();
  w.db.close();
});

test('a provider switch during proof cannot leave a stale result under the original provider id (#733)', async () => {
  const w = world();
  run(w.db, `UPDATE sync_ledger SET custody_authority_id = NULL WHERE photo_id = 'P1'`);
  await putBootstrap(w.provider, w.masterKey);
  const alternate = new MockProvider({
    rootDir: mkdtempSync(join(tmpdir(), 'overlook-custody-reconnect-alternate-')),
    libraryId: LIBRARY_ID,
    accountIdentity: { accountId: 'account-a', accountLabel: 'Account A' },
  });
  Object.defineProperty(alternate, 'id', { value: 'pcloud' });
  await putBootstrap(alternate, w.masterKey);
  let activeId = 'mock';
  let releaseIdentity: (() => void) | undefined;
  let identityStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    identityStarted = resolve;
  });
  const accountIdentity = w.provider.accountIdentity.bind(w.provider);
  w.provider.accountIdentity = () =>
    new Promise((resolve) => {
      releaseIdentity = () => resolve({ accountId: 'account-a', accountLabel: 'Account A' });
      identityStarted?.();
    });
  const providers = new Map([
    ['mock', w.provider],
    ['pcloud', alternate],
  ]);
  const activeProvider = createActiveProvider({
    registry: { get: (id) => providers.get(id) },
    activeId: () => activeId,
    defaultId: () => 'mock',
  });
  const routing = createCustodyRoutingRuntime({
    db: w.db,
    backupTarget: activeProvider,
    libraryId: () => LIBRARY_ID,
    provider: (providerId) => providers.get(providerId),
    backupTargetConnected: () => true,
    status: (photoId) => w.ledger.status(photoId),
    now: () => VERIFIED_AT,
    masterKey: () => Buffer.from(w.masterKey),
  });

  await started;
  activeId = 'pcloud';
  releaseIdentity?.();
  await waitFor(
    () => w.authorities.verified('pcloud', 'account-a', ROOT) !== undefined,
    'the switched provider never published its verified authority',
  );
  w.provider.accountIdentity = accountIdentity;
  activeId = 'mock';
  assert.equal((await routing.integrity.legacyAuthority())?.authority.id, w.authority.id, 'the original provider is re-proven');
  await routing.close();
  w.db.close();
});

test('closing custody routing aborts startup proof and zeros its copied master key before teardown (#733)', async () => {
  const w = world();
  let releaseStream: ((stream: Readable) => void) | undefined;
  let issuedMasterKey: Buffer | undefined;
  let streamRequestStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    streamRequestStarted = resolve;
  });
  w.provider.getStream = () =>
    new Promise<Readable>((resolve) => {
      releaseStream = resolve;
      streamRequestStarted?.();
    });
  const routing = createCustodyRoutingRuntime({
    db: w.db,
    backupTarget: w.provider,
    libraryId: () => LIBRARY_ID,
    provider: (providerId) => (providerId === w.provider.id ? w.provider : undefined),
    backupTargetConnected: () => true,
    status: (photoId) => w.ledger.status(photoId),
    now: () => VERIFIED_AT,
    masterKey: () => {
      issuedMasterKey = Buffer.from(w.masterKey);
      return issuedMasterKey;
    },
  });

  await started;
  await routing.close();
  assert.ok(
    issuedMasterKey?.every((byte) => byte === 0),
    'the proof key copy is zeroed before close resolves',
  );
  const lateStream = Readable.from([Buffer.from('late')]);
  releaseStream?.(lateStream);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateStream.destroyed, true, 'a provider stream arriving after cancellation is discarded');
  w.db.close();
});

test('a persisted bound authority is re-proven before its first custody handle after restart (#733)', async () => {
  const w = world();
  w.authorities.restoreBound([w.authority.id]);
  await putBootstrap(w.provider, w.masterKey);
  const originalGetStream = w.provider.getStream.bind(w.provider);
  let bootstrapReads = 0;
  w.provider.getStream = (path) => {
    if (path === 'recovery/bootstrap.ovrb') bootstrapReads += 1;
    return originalGetStream(path);
  };
  const routing = createCustodyRoutingRuntime({
    db: w.db,
    backupTarget: w.provider,
    libraryId: () => LIBRARY_ID,
    provider: (providerId) => (providerId === w.provider.id ? w.provider : undefined),
    backupTargetConnected: () => true,
    status: (photoId) => w.ledger.status(photoId),
    now: () => VERIFIED_AT,
    masterKey: () => Buffer.from(w.masterKey),
  });

  const handle = await routing.resolver.resolveAuthority(w.authorities.get(w.authority.id) ?? w.authority);
  assert.equal(handle.authority.lastVerifiedAt, VERIFIED_AT);
  assert.equal(handle.authority.state, 'bound');
  assert.equal(w.ledger.status('P1'), 'offloaded');
  w.provider.setConnected(false);
  await assert.rejects(routing.resolver.resolveAuthority(handle.authority), /custody-disconnected/u);
  w.provider.setConnected(true);
  await routing.resolver.resolveAuthority(handle.authority);
  assert.ok(bootstrapReads >= 2, 'custody recovery re-proves the bootstrap after provider unavailability');
  w.db.close();
});

test('purge source capture refuses unbound clean-error custody and bounds an unresponsive identity provider', async () => {
  const w = world();
  run(w.db, "UPDATE sync_ledger SET status = 'synced', custody_authority_id = NULL, dirty = 0 WHERE photo_id = 'P1'");
  let calls = 0;
  let providerSignal: AbortSignal | undefined;
  w.provider.accountIdentity = (signal?: AbortSignal) => {
    calls += 1;
    providerSignal = signal;
    return new Promise<ProviderAccountIdentity>(() => undefined);
  };
  const timeout = new AbortController();
  const routing = createCustodyRoutingRuntime({
    db: w.db,
    backupTarget: w.provider,
    libraryId: () => LIBRARY_ID,
    provider: () => w.provider,
    backupTargetConnected: () => true,
    status: (photoId) => w.ledger.status(photoId),
    now: () => VERIFIED_AT,
    timeoutSignal: (milliseconds) => {
      assert.equal(milliseconds, 10_000);
      return timeout.signal;
    },
    masterKey: () => Buffer.from(w.masterKey),
  });
  try {
    run(w.db, "UPDATE sync_ledger SET status = 'error', dirty = 0 WHERE photo_id = 'P1'");
    await assert.rejects(routing.captureAuthority('P1'), /custody-unavailable/u);
    assert.equal(calls, 0, 'a selected account cannot claim an unknown legacy source');
    run(w.db, "UPDATE sync_ledger SET status = 'synced' WHERE photo_id = 'P1'");
    const capture = routing.captureAuthority('P1');
    assert.equal(calls, 1);
    assert.equal(providerSignal, timeout.signal);
    timeout.abort(new Error('identity timed out'));
    await assert.rejects(capture, /custody-unavailable/u);
    assert.equal(providerSignal?.aborted, true);
    assert.equal(w.authorities.forPhoto('P1'), undefined);
    assert.ok(w.photos.get('P1'), 'failed capture does not remove the photo');
  } finally {
    await routing.close();
    w.db.close();
  }
});

function unboundRouting() {
  const w = world();
  run(w.db, "UPDATE sync_ledger SET status = 'synced', custody_authority_id = NULL WHERE photo_id = 'P1'");
  run(w.db, 'DELETE FROM custody_authorities');
  const deadlines: AbortController[] = [];
  const routing = createCustodyRoutingRuntime({
    db: w.db,
    backupTarget: w.provider,
    libraryId: () => LIBRARY_ID,
    provider: () => w.provider,
    backupTargetConnected: () => true,
    status: (photoId) => w.ledger.status(photoId),
    now: () => VERIFIED_AT,
    timeoutSignal: (milliseconds) => {
      assert.equal(milliseconds, 10_000);
      const deadline = new AbortController();
      deadlines.push(deadline);
      return deadline.signal;
    },
    masterKey: () => Buffer.from(w.masterKey),
  });
  const authorityCount = (): number => queryGet<{ count: number }>(w.db, 'SELECT COUNT(*) AS count FROM custody_authorities')?.count ?? 0;
  return { ...w, routing, deadlines, authorityCount };
}

for (const path of ['legacy', 'offload'] as const) {
  test(
    `${path} identity timeout aborts the provider, ignores late success, and permits a fresh retry (#1193)`,
    { timeout: 10_000 },
    async () => {
      const w = unboundRouting();
      const identity = await w.provider.accountIdentity();
      await putBootstrap(w.provider, w.masterKey);
      if (path === 'legacy') w.ledger.setStatus('P1', 'offloaded');
      let providerSignal: AbortSignal | undefined;
      let complete: ((value: ProviderAccountIdentity) => void) | undefined;
      w.provider.accountIdentity = (signal?: AbortSignal) => {
        providerSignal = signal;
        return new Promise<ProviderAccountIdentity>((resolve) => {
          complete = resolve;
        });
      };
      try {
        const pending = path === 'legacy' ? w.routing.integrity.legacyAuthority() : w.routing.offloadAuthority(10);
        assert.equal(providerSignal, w.deadlines[0]?.signal);
        assert.ok(complete);
        assert.ok(w.deadlines[0]);
        w.deadlines[0].abort(new Error('identity deadline'));
        if (path === 'legacy') assert.equal(await pending, null);
        else await assert.rejects(pending, /custody-unavailable/u);
        assert.equal(providerSignal?.aborted, true);
        assert.equal(w.authorityCount(), 0);
        assert.equal(w.authorities.forPhoto('P1'), undefined);
        complete(identity);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(w.authorityCount(), 0, 'late identity must not create custody');
        assert.equal(w.ledger.status('P1'), path === 'legacy' ? 'offloaded' : 'synced');
        w.provider.accountIdentity = () => Promise.resolve(identity);
        if (path === 'legacy') {
          const handle = await w.routing.integrity.legacyAuthority();
          assert.equal(handle?.authority.lastVerifiedAt, VERIFIED_AT);
          assert.equal(handle?.authority.accountId, identity.accountId);
        } else {
          const authorityId = await w.routing.offloadAuthority(10);
          assert.equal(w.authorities.get(authorityId)?.accountId, identity.accountId);
        }
        assert.equal(w.authorityCount(), 1);
      } finally {
        await w.routing.close();
        w.db.close();
      }
    },
  );
}

for (const stalledCall of [2, 3]) {
  test(
    `legacy lookup bounds reconnect identity call ${String(stalledCall)} without granting custody (#1193)`,
    { timeout: 10_000 },
    async () => {
      const w = unboundRouting();
      const identity = await w.provider.accountIdentity();
      await putBootstrap(w.provider, w.masterKey);
      w.ledger.setStatus('P1', 'offloaded');
      let calls = 0;
      let providerSignal: AbortSignal | undefined;
      let complete: ((value: ProviderAccountIdentity) => void) | undefined;
      let reached: (() => void) | undefined;
      const stalled = new Promise<void>((resolve) => {
        reached = resolve;
      });
      w.provider.accountIdentity = (signal?: AbortSignal) => {
        calls += 1;
        if (calls !== stalledCall) return Promise.resolve(identity);
        providerSignal = signal;
        reached?.();
        return new Promise<ProviderAccountIdentity>((resolve) => {
          complete = resolve;
        });
      };
      try {
        const pending = w.routing.integrity.legacyAuthority();
        await stalled;
        assert.equal(w.deadlines.length, 2, 'reconnect shares one deadline across identity, bootstrap, and confirmation');
        assert.ok(w.deadlines[1]);
        w.deadlines[1].abort(new Error('reconnect deadline'));
        assert.equal(await pending, null);
        assert.equal(providerSignal?.aborted, true);
        assert.ok(complete);
        complete(identity);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(w.authorityCount(), 0);
        assert.equal(w.authorities.forPhoto('P1'), undefined);
        assert.equal(w.ledger.status('P1'), 'offloaded');
      } finally {
        await w.routing.close();
        w.db.close();
      }
    },
  );
}

test('legacy final handle identity timeout preserves existing custody and refuses a late result (#1193)', { timeout: 10_000 }, async () => {
  const w = unboundRouting();
  const identity = await w.provider.accountIdentity();
  await putBootstrap(w.provider, w.masterKey);
  const authority = w.authorities.create({
    providerId: w.provider.id,
    ...identity,
    remoteRoot: ROOT,
    createdAt: VERIFIED_AT,
    lastVerifiedAt: VERIFIED_AT,
  });
  w.ledger.setStatus('P1', 'offloaded');
  let calls = 0;
  let providerSignal: AbortSignal | undefined;
  let complete: ((value: ProviderAccountIdentity) => void) | undefined;
  let reached: (() => void) | undefined;
  const stalled = new Promise<void>((resolve) => {
    reached = resolve;
  });
  w.provider.accountIdentity = (signal?: AbortSignal) => {
    calls += 1;
    if (calls < 4) return Promise.resolve(identity);
    providerSignal = signal;
    reached?.();
    return new Promise<ProviderAccountIdentity>((resolve) => {
      complete = resolve;
    });
  };
  try {
    const pending = w.routing.integrity.legacyAuthority();
    await stalled;
    assert.equal(w.deadlines.length, 3);
    assert.ok(w.deadlines[2]);
    assert.equal(providerSignal, w.deadlines[2].signal);
    w.deadlines[2].abort(new Error('final identity deadline'));
    assert.equal(await pending, null);
    assert.equal(providerSignal?.aborted, true);
    assert.ok(complete);
    complete(identity);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(w.authorityCount(), 1);
    assert.deepEqual(w.authorities.get(authority.id), authority);
    assert.equal(w.authorities.forPhoto('P1'), undefined);
    assert.equal(w.ledger.status('P1'), 'offloaded');
  } finally {
    await w.routing.close();
    w.db.close();
  }
});
