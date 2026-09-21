import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { ProviderError } from '../../src/main/backup/provider.js';
import { CustodyAuthorityRepository } from '../../src/main/backup/custody-authority-repository.js';
import { CustodyHandleResolver, custodyRemoteRoot } from '../../src/main/backup/custody-handle.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { VariantRepository } from '../../src/main/db/variant-repository.js';
import { run } from '../../src/main/db/sql.js';
import { createPurgeCleanup, createPurgeService } from '../../src/main/library/purge-factory.js';
import { PurgeCleanupRepository } from '../../src/main/library/purge-cleanup-repository.js';

const AT = '2026-09-20T00:00:00.000Z';
class Provider extends MockProvider {
  failDeletes = false;
  deletes = 0;
  override async delete(path: string): Promise<void> {
    this.deletes += 1;
    if (this.failDeletes) throw new ProviderError('injected delete failure', 'transient');
    return super.delete(path);
  }
}

async function world() {
  const root = mkdtempSync(join(tmpdir(), 'overlook-purge-cleanup-'));
  const dbKey = randomBytes(32);
  const databasePath = join(root, 'library.db');
  let db = openLibraryDatabase({ path: databasePath, dbKey });
  const store = new BlobStore({ dataDir: root });
  await store.init();
  const ref = await store.putOriginal(Readable.from('original'), { id: 1, key: randomBytes(32) }, 'photo');
  const provider = new Provider({ rootDir: join(root, 'remote') });
  const remotePath = `blobs/${ref.contentHash.slice(0, 2)}/${ref.contentHash}`;
  await provider.put(remotePath, Readable.from('encrypted remote object'));
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped', ?)`, AT);
  new PhotosRepository(db).insert({
    id: 'photo',
    fileName: 'photo.jpg',
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
    importedAt: AT,
    importSource: 'test',
    keyId: 1,
  });
  const ledger = new SyncLedger(db);
  ledger.setStatus('photo', 'syncing');
  ledger.markBackedUp('photo', AT);
  ledger.markExcluding('photo', 'user', AT);
  const authority = new CustodyAuthorityRepository(db).create({
    providerId: provider.id,
    accountId: 'mock-account',
    accountLabel: 'Mock account',
    remoteRoot: custodyRemoteRoot('library'),
    createdAt: AT,
  });
  run(db, 'UPDATE sync_ledger SET custody_authority_id = ? WHERE photo_id = ?', authority.id, 'photo');
  const bind = (target = authority) => {
    const photos = new PhotosRepository(db);
    const authorities = new CustodyAuthorityRepository(db);
    const cleanup = createPurgeCleanup(db, {
      authorities,
      custody: new CustodyHandleResolver({
        authorityForPhoto: (id) => authorities.forPhoto(id),
        provider: () => provider,
        remoteRoot: () => custodyRemoteRoot('library'),
      }),
      captureAuthority: (id) => {
        const value = authorities.forPhoto(id);
        assert.ok(value);
        return Promise.resolve(value);
      },
      ensureTargetAuthority: () => Promise.resolve(target),
      audit: () => undefined,
    });
    const purge = createPurgeService({
      db,
      repo: photos,
      blobStore: store,
      cleanup,
      remoteProvider: () => Promise.resolve(provider),
      custodyChanged: () => undefined,
      oweManifest: () => undefined,
      libraryChanged: () => undefined,
      audit: () => undefined,
      retention: () => '30',
    });
    return { photos, authorities, cleanup, purge, queue: new PurgeCleanupRepository(db) };
  };
  return {
    bind,
    provider,
    store,
    hash: ref.contentHash,
    remotePath,
    db: () => db,
    reopen: () => {
      db.close();
      db = openLibraryDatabase({ path: databasePath, dbKey });
    },
    close: () => db.close(),
  };
}

async function certify(cleanup: ReturnType<typeof createPurgeCleanup>, retained: readonly string[] = []) {
  cleanup.settleManifest(await cleanup.snapshot(), retained);
}

test('purge transfers exclusion debt before CASCADE, survives failed deletion and restart, and retries', async () => {
  const w = await world();
  try {
    let b = w.bind();
    b.photos.softDelete(['photo']);
    assert.equal((await b.purge.purge(['photo'])).remoteFailures, 1);
    assert.equal(b.photos.getDeleted('photo'), undefined);
    assert.equal(new SyncLedger(w.db()).status('photo'), undefined);
    assert.equal(b.queue.pending().length, 1);
    const source = b.queue.pending()[0]!;
    const authority = b.authorities.get(source.authorityId)!;
    b.authorities.deleteUnreferenced(authority.providerId, authority.accountId);
    assert.ok(b.authorities.get(authority.id), 'cleanup retains its source authority');
    assert.deepEqual(
      b.authorities.stageReconnectVerification(authority.providerId).map((item) => item.id),
      [authority.id],
    );
    b.authorities.markVerified([authority.id], AT);
    assert.equal(w.store.hasOriginal(w.hash), false);
    assert.equal(w.provider.deletes, 0, 'no provider delete before manifest publication');
    await b.cleanup.retry();
    assert.equal(w.provider.deletes, 0);
    w.provider.failDeletes = true;
    await certify(b.cleanup);
    assert.deepEqual(await b.cleanup.retry(), { settled: 0, pending: 1 });
    w.reopen();
    b = w.bind();
    w.provider.failDeletes = false;
    await b.cleanup.retry();
    assert.equal(w.provider.deletes, 1, 'restart requires fresh publication evidence');
    await certify(b.cleanup);
    assert.deepEqual(await b.cleanup.retry(), { settled: 1, pending: 0 });
    assert.deepEqual(await w.provider.list('blobs'), []);
  } finally {
    w.close();
  }
});

test('queue persistence failure preserves the photo, ledger and local original', async () => {
  const w = await world();
  try {
    const b = w.bind();
    b.photos.softDelete(['photo']);
    run(w.db(), "CREATE TRIGGER reject_cleanup BEFORE INSERT ON purge_remote_cleanup BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END");
    await assert.rejects(b.purge.purge(['photo']), /queue unavailable/u);
    assert.ok(b.photos.getDeleted('photo'));
    assert.equal(new SyncLedger(w.db()).coverage('photo')?.coverage, 'excluding');
    assert.equal(w.store.hasOriginal(w.hash), true);
    assert.equal(w.provider.deletes, 0);
  } finally {
    w.close();
  }
});

test('shared claims, retained manifest paths and wrong accounts cannot authorize queued deletion', async () => {
  const w = await world();
  try {
    const b = w.bind();
    new VariantRepository(w.db()).duplicate(b.photos.get('photo')!, 'sibling', AT);
    run(w.db(), "UPDATE sync_ledger SET coverage = 'included' WHERE photo_id = 'sibling'");
    b.photos.softDelete(['photo']);
    await b.purge.purge(['photo']);
    await certify(b.cleanup, [w.remotePath]);
    await b.cleanup.retry();
    assert.equal(w.provider.deletes, 0);
    run(w.db(), "DELETE FROM photos WHERE id = 'sibling'");
    await b.cleanup.retry();
    assert.equal(w.provider.deletes, 0, 'removing a sibling cannot reuse the earlier manifest');
    await certify(b.cleanup);
    w.provider.setAccountIdentity({ accountId: 'wrong-account', accountLabel: 'Wrong' });
    assert.deepEqual(await b.cleanup.retry(), { settled: 0, pending: 1 });
    assert.equal(w.provider.deletes, 0);
    w.provider.setAccountIdentity({ accountId: 'mock-account', accountLabel: 'Mock' });
    await certify(b.cleanup);
    assert.deepEqual(await b.cleanup.retry(), { settled: 1, pending: 0 });
  } finally {
    w.close();
  }
});

test('a different publication account and rows queued after its snapshot cannot release deletion', async () => {
  const w = await world();
  try {
    const b = w.bind();
    const before = await b.cleanup.snapshot();
    b.photos.softDelete(['photo']);
    await b.purge.purge(['photo']);
    b.cleanup.settleManifest(before, []);
    await b.cleanup.retry();
    assert.equal(w.provider.deletes, 0);
    const other = b.authorities.create({
      providerId: w.provider.id,
      accountId: 'other',
      accountLabel: 'Other',
      remoteRoot: custodyRemoteRoot('library'),
      createdAt: AT,
    });
    const changed = w.bind(other);
    assert.deepEqual(await changed.cleanup.snapshot(), []);
    await certify(changed.cleanup);
    await changed.cleanup.retry();
    assert.equal(w.provider.deletes, 0);
    await w.provider.delete(w.remotePath);
    await certify(b.cleanup);
    assert.deepEqual(await b.cleanup.retry(), { settled: 1, pending: 0 }, 'already absent objects settle idempotently');
  } finally {
    w.close();
  }
});

test('a clean-error transition during identity capture preserves the photo and retry ledger', async () => {
  const w = await world();
  try {
    const b = w.bind();
    const captured = b.authorities.forPhoto('photo')!;
    b.photos.softDelete(['photo']);
    run(w.db(), "UPDATE sync_ledger SET custody_authority_id = NULL WHERE photo_id = 'photo'");
    const cleanup = createPurgeCleanup(w.db(), {
      authorities: b.authorities,
      custody: { resolveAuthority: () => Promise.reject(new Error('unexpected remote resolution')) },
      captureAuthority: async () => {
        await Promise.resolve();
        run(w.db(), "UPDATE sync_ledger SET status = 'error', dirty = 0 WHERE photo_id = 'photo'");
        return captured;
      },
      ensureTargetAuthority: () => Promise.resolve(captured),
      audit: () => undefined,
    });
    await assert.rejects(
      cleanup.transfer('photo', () => b.photos.purgeRow('photo')),
      /unverified source authority/u,
    );
    assert.ok(b.photos.getDeleted('photo'));
    assert.equal(new SyncLedger(w.db()).coverage('photo')?.coverage, 'excluding');
    assert.equal(b.queue.pending().length, 0);
    assert.equal(w.store.hasOriginal(w.hash), true);
    assert.equal(w.provider.deletes, 0);
  } finally {
    w.close();
  }
});
