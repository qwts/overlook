import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';

import { BackupEngine, type BackupEngineDeps } from '../../src/main/backup/backup-engine.js';
import { createManifestDebtStore } from '../../src/main/backup/manifest-debt.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { ProviderError, type RemoteEntry } from '../../src/main/backup/provider.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('not initialized');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function world() {
  const root = mkdtempSync(join(tmpdir(), 'overlook-publication-'));
  const path = join(root, 'library.db');
  const dbKey = randomBytes(32);
  let db = openLibraryDatabase({ path, dbKey });
  const provider = new MockProvider({ rootDir: join(root, 'remote') });
  const deadlines: AbortController[] = [];
  const audits: string[] = [];
  let clock = 0;
  const engine = (): BackupEngine =>
    new BackupEngine({
      provider,
      ledger: new SyncLedger(db),
      dirtyPhotos: () => [],
      encryptedStream: () => Readable.from([]),
      manifestSnapshot: () => new PhotosRepository(db).manifestSnapshot(),
      sealManifest: (json) => Promise.resolve(Buffer.from(json)),
      sealRecoveryBootstrap: (publication) => Buffer.from(JSON.stringify(publication)),
      libraryId: () => '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      settings: () => ({ throttlePercent: null, wifiOnly: false, autoBackupOnImport: false }),
      network: () => 'wifi',
      now: () => ++clock,
      sleep: () => Promise.resolve(),
      events: { progress: () => undefined },
      pendingCountChanged: () => undefined,
      syncStateChanged: () => undefined,
      audit: (line) => {
        audits.push(line);
      },
      integrityScrub: () => Promise.resolve({ checked: 0, repaired: 0, unrecoverable: 0, cycleComplete: false }),
      recoveryGenerationHealthy: () => Promise.resolve(true),
      manifestDebt: createManifestDebtStore(db),
      publicationTimeoutSignal: (ms) => {
        assert.equal(ms, 120_000);
        const controller = new AbortController();
        deadlines.push(controller);
        return controller.signal;
      },
    } satisfies BackupEngineDeps);
  return {
    provider,
    deadlines,
    audits,
    engine,
    debt: () => createManifestDebtStore(db),
    reopen: () => {
      db.close();
      db = openLibraryDatabase({ path, dbKey });
    },
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
    expire: () => {
      const deadline = deadlines.at(-1);
      assert.ok(deadline);
      deadline.abort(new Error('deadline'));
    },
    publish: async () => {
      const next = engine();
      next.oweManifest();
      return next.run();
    },
  };
}

test('manifest listing timeout forwards cancellation, preserves debt, and permits a fresh run', { timeout: 10_000 }, async () => {
  const w = world();
  const reached = deferred<void>();
  const list = w.provider.list.bind(w.provider);
  let providerSignal: AbortSignal | undefined;
  w.provider.list = (_prefix, signal) => {
    providerSignal = signal;
    reached.resolve();
    return new Promise<readonly RemoteEntry[]>(() => undefined);
  };
  try {
    const pending = w.publish();
    await reached.promise;
    w.expire();
    assert.equal((await pending).manifestUploaded, false);
    assert.equal(providerSignal?.aborted, true);
    assert.equal(w.debt().load(), true);
    assert.equal(w.debt().publicationJournal?.load(), null);
    assert.ok(w.audits.includes('MANIFEST-PUBLISH-FAIL reason=timeout outcome=incomplete'));
    w.provider.list = list;
    assert.equal((await w.engine().run()).manifestUploaded, true);
    assert.equal(w.debt().load(), false);
  } finally {
    w.close();
  }
});

for (const committed of [false, true]) {
  test(
    `bootstrap timeout survives restart and ${committed ? 'reconciles committed bytes' : 'blocks an unconfirmed write'}`,
    { timeout: 10_000 },
    async () => {
      const w = world();
      const reached = deferred<void>();
      const finish = deferred<{ bytes: number }>();
      const put = w.provider.put.bind(w.provider);
      let payload: Buffer | undefined;
      try {
        assert.equal((await w.publish()).manifestUploaded, true);
        const previous = await buffer(await w.provider.getStream('manifest/gen-1.ovlk'));
        w.provider.put = async (path, stream) => {
          assert.equal(path, 'recovery/bootstrap.ovrb');
          payload = await buffer(stream);
          if (committed) await put(path, Readable.from([payload]));
          reached.resolve();
          return finish.promise;
        };
        const pending = w.publish();
        await reached.promise;
        w.expire();
        assert.equal((await pending).manifestUploaded, false);
        assert.equal(w.debt().publicationJournal?.load()?.settled, false);
        assert.throws(() => w.debt().save(false), /unresolved publication/u);
        w.reopen();
        w.provider.put = put;
        if (!committed) {
          assert.equal((await w.engine().run()).manifestUploaded, false);
          assert.deepEqual(
            (await w.provider.list('manifest')).map((entry) => entry.path),
            ['manifest/gen-1.ovlk'],
          );
          assert.ok(payload);
          await put('recovery/bootstrap.ovrb', Readable.from([payload]));
        }
        assert.equal((await w.engine().run()).manifestUploaded, true);
        assert.equal(w.debt().load(), false);
        assert.equal(w.debt().publicationJournal?.load(), null);
        assert.deepEqual(await buffer(await w.provider.getStream('manifest/gen-1.ovlk')), previous);
        const currentBootstrap = await buffer(await w.provider.getStream('recovery/bootstrap.ovrb'));
        finish.resolve({ bytes: payload?.length ?? 0 });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(w.debt().load(), false, 'late completion must not touch debt in the reopened database');
        assert.deepEqual(await buffer(await w.provider.getStream('recovery/bootstrap.ovrb')), currentBootstrap);
      } finally {
        w.close();
      }
    },
  );
}

for (const stage of ['verification', 'retention'] as const) {
  test(
    `cancellation during ${stage} preserves recovery generations and resumes only after reconciliation`,
    { timeout: 10_000 },
    async () => {
      const w = world();
      const reached = deferred<void>();
      const finish = deferred<void>();
      const verify = w.provider.verify.bind(w.provider);
      const remove = w.provider.delete.bind(w.provider);
      let mutationLanded = false;
      const put = w.provider.put.bind(w.provider);
      try {
        assert.equal((await w.publish()).manifestUploaded, true);
        assert.equal((await w.publish()).manifestUploaded, true);
        if (stage === 'verification') {
          w.provider.put = async (path, bytes) => {
            const result = await put(path, bytes);
            if (path === 'manifest/gen-3.ovlk') mutationLanded = true;
            return result;
          };
          w.provider.verify = (path) => {
            if (path === 'manifest/gen-3.ovlk' && mutationLanded) {
              reached.resolve();
              return new Promise(() => undefined);
            }
            return verify(path);
          };
        } else {
          w.provider.delete = (path) => {
            assert.equal(path, 'manifest/gen-1.ovlk');
            reached.resolve();
            return finish.promise;
          };
        }
        const controller = new AbortController();
        const engine = w.engine();
        engine.oweManifest();
        const pending = engine.run(controller.signal);
        await reached.promise;
        controller.abort(new Error('cancelled'));
        assert.equal((await pending).manifestUploaded, false);
        assert.equal(w.debt().load(), true);
        assert.ok(w.audits.includes('MANIFEST-PUBLISH-FAIL reason=cancelled outcome=unknown'));
        assert.deepEqual((await w.provider.list('manifest')).map((entry) => entry.path).sort(), [
          'manifest/gen-1.ovlk',
          'manifest/gen-2.ovlk',
          'manifest/gen-3.ovlk',
        ]);
        w.provider.put = put;
        w.provider.verify = verify;
        w.provider.delete = remove;
        if (stage === 'retention') {
          assert.equal((await w.engine().run()).manifestUploaded, false);
          await remove('manifest/gen-1.ovlk');
          finish.resolve();
        }
        assert.equal((await w.engine().run()).manifestUploaded, true);
        assert.equal(w.debt().load(), false);
        assert.deepEqual((await w.provider.list('manifest')).map((entry) => entry.path).sort(), [
          'manifest/gen-3.ovlk',
          'manifest/gen-4.ovlk',
        ]);
      } finally {
        w.close();
      }
    },
  );
}

test('identical existing bytes do not prove that an abandoned replacement completed', { timeout: 10_000 }, async () => {
  const w = world();
  try {
    assert.equal((await w.publish()).manifestUploaded, true);
    const stamp = await w.provider.verify('recovery/bootstrap.ovrb');
    const journal = w.debt().publicationJournal;
    assert.ok(journal);
    journal.save({
      providerId: w.provider.id,
      accountId: (await w.provider.accountIdentity()).accountId,
      libraryId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      path: 'recovery/bootstrap.ovrb',
      expected: stamp,
      before: stamp,
      settled: false,
    });
    assert.equal((await w.engine().run()).manifestUploaded, false);
    assert.equal(w.debt().load(), true);
    assert.ok(journal.load());
    assert.deepEqual(
      (await w.provider.list('manifest')).map((entry) => entry.path),
      ['manifest/gen-1.ovlk'],
    );
  } finally {
    w.close();
  }
});

test('unverified newer listing entries cannot evict the verified predecessor', { timeout: 10_000 }, async () => {
  const w = world();
  const put = w.provider.put.bind(w.provider);
  try {
    assert.equal((await w.publish()).manifestUploaded, true);
    assert.equal((await w.publish()).manifestUploaded, true);
    w.provider.put = async (path, bytes) => {
      const result = await put(path, bytes);
      if (path === 'manifest/gen-3.ovlk') await put('manifest/gen-99.ovlk', Readable.from([Buffer.from('unverified')]));
      return result;
    };
    assert.equal((await w.publish()).manifestUploaded, true);
    assert.deepEqual((await w.provider.list('manifest')).map((entry) => entry.path).sort(), [
      'manifest/gen-2.ovlk',
      'manifest/gen-3.ovlk',
      'manifest/gen-99.ovlk',
    ]);
  } finally {
    w.close();
  }
});

test('a rejected network write remains uncertain until its intended bytes are observed', { timeout: 10_000 }, async () => {
  const w = world();
  const put = w.provider.put.bind(w.provider);
  let payload: Buffer | undefined;
  try {
    assert.equal((await w.publish()).manifestUploaded, true);
    w.provider.put = async (_path, stream) => {
      payload = await buffer(stream);
      throw new ProviderError('response lost after sending the request', 'transient');
    };
    assert.equal((await w.publish()).manifestUploaded, false);
    assert.equal(w.debt().publicationJournal?.load()?.settled, false);
    w.provider.put = put;
    assert.equal((await w.engine().run()).manifestUploaded, false, 'absence is not proof that the write stopped');
    assert.ok(payload);
    await put('recovery/bootstrap.ovrb', Readable.from([payload]));
    assert.equal((await w.engine().run()).manifestUploaded, true);
    assert.equal(w.debt().load(), false);
  } finally {
    w.close();
  }
});
