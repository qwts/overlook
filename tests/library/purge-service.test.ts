import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { CustodyResolutionError } from '../../src/main/backup/custody-handle.js';
import { PurgeService } from '../../src/main/library/purge-service.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import { sampleJpeg } from '../../src/main/library/seed.js';
import type { EnvelopeKey } from '../../src/main/crypto/envelope.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';
import type { TrashRetention } from '../../src/shared/library/trash.js';

// #121: the one truly destructive path over REAL store/repo/provider —
// all three copies go; failures leave a repairable, non-lying state.

const NOW = Date.parse('2026-07-13T12:00:00.000Z');

async function world(count: number, options: { contentHash?: string; retention?: TrashRetention } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-purge-'));
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT OR IGNORE INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-01T00:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  const store = new BlobStore({ dataDir });
  await store.init();
  const key: EnvelopeKey = { id: 1, key: randomBytes(32) };
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-purge-remote-')) });
  const hashes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = sampleJpeg(options.contentHash === undefined ? index : 0);
    const ref = await store.putOriginal(Readable.from([bytes]), key, `P${String(index)}`);
    await store.putThumb(Readable.from([bytes]), key, `P${String(index)}`, ref.contentHash, 'thumb');
    await provider.put(`blobs/${ref.contentHash.slice(0, 2)}/${ref.contentHash}`, store.getEncryptedStream(ref.contentHash));
    hashes.push(ref.contentHash);
    repo.insert({
      id: `P${String(index)}`,
      fileName: `IMG_${String(index)}.JPG`,
      fileKind: 'jpeg',
      width: 1,
      height: 1,
      bytes: ref.bytes,
      contentHash: options.contentHash === undefined ? ref.contentHash : `${ref.contentHash}-${String(index)}`,
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
      importedAt: '2026-07-01T00:00:00.000Z',
      importSource: 'test',
      keyId: 1,
    } satisfies PhotoInsert);
  }
  const audits: string[] = [];
  const owed: number[] = [];
  const changed: string[][] = [];
  const service = new PurgeService({
    repo: {
      getDeleted: (id) => repo.getDeleted(id),
      getAny: (id) => repo.get(id),
      purgeRow: (id) => {
        repo.purgeRow(id);
      },
      purgeRowAuthorized: (id) => {
        repo.purgeRowAuthorized(id);
      },
      countAnyByContentHash: (hash) => repo.countAnyByContentHash(hash),
      expiredDeleted: (cutoff) => repo.expiredDeleted(cutoff),
      sidecarHashesForPhoto: () => [],
    },
    blobs: {
      deleteOriginal: async (hash) => store.deleteOriginal(hash),
      deleteThumbs: async (hash) => store.deleteThumbs(hash),
      deleteSidecars: async (photoId) => store.deleteSidecars(photoId),
    },
    remoteProvider: async () => {
      if ((await provider.authState()) !== 'connected') throw new CustodyResolutionError('custody-disconnected');
      return provider;
    },
    custodyChanged: () => undefined,
    oweManifest: () => owed.push(1),
    libraryChanged: (ids) => changed.push([...ids]),
    audit: (line) => audits.push(line),
    retention: () => options.retention ?? '30',
    now: () => NOW,
    sleep: () => Promise.resolve(),
  });
  return {
    db,
    repo,
    store,
    provider,
    hashes,
    audits,
    owed,
    changed,
    service,
    dataDir,
  };
}

describe('purge (#121)', () => {
  test('EXIT CRITERIA: purge removes all three copies — DB row, local blobs, remote', async () => {
    const w = await world(1);
    const hash = w.hashes[0] ?? '';
    w.repo.softDelete(['P0']);

    const summary = await w.service.purge(['P0']);
    assert.deepEqual(summary, { purged: 1, skipped: 0, protected: 0, remoteFailures: 0 });
    assert.equal(w.repo.get('P0'), undefined, 'DB row gone');
    assert.equal(w.store.hasOriginal(hash), false, 'local original gone');
    assert.equal(existsSync(join(w.dataDir, 'blobs')), true);
    assert.equal((await w.provider.list('blobs')).length, 0, 'remote copy gone');
    assert.ok(w.audits.some((line) => line.startsWith('PURGE photo=P0')));
    assert.equal(w.owed.length, 1, 'the manifest generation is owed');
    assert.deepEqual(w.changed, [['P0']]);
  });

  test('live rows are skipped, never forced — only Trash purges', async () => {
    const w = await world(1);
    const summary = await w.service.purge(['P0', 'GHOST']);
    assert.deepEqual(summary, { purged: 0, skipped: 2, protected: 0, remoteFailures: 0 });
    assert.notEqual(w.repo.get('P0'), undefined);
    assert.equal(w.owed.length, 0);
  });

  test('a failed remote delete leaves a repairable, non-lying state (audited orphan)', async () => {
    const w = await world(1);
    const hash = w.hashes[0] ?? '';
    w.repo.softDelete(['P0']);
    w.provider.setConnected(false); // every remote call now fails kind=auth

    const summary = await w.service.purge(['P0']);
    assert.deepEqual({ purged: summary.purged, remoteFailures: summary.remoteFailures }, { purged: 1, remoteFailures: 1 });
    assert.equal(w.repo.get('P0'), undefined, 'DB never lies — the row went first');
    assert.equal(w.store.hasOriginal(hash), false, 'local copy gone');
    assert.ok(
      w.audits.some((line) => line.startsWith(`ORPHAN-REMOTE photo=P0 hash=${hash}`)),
      'the orphaned remote copy is audited for M11 repair',
    );
  });

  test('retention sweep honors Off and the exact 7 / 30 / 90-day boundaries', async () => {
    const off = await world(1, { retention: 'off' });
    off.repo.softDelete(['P0']);
    run(off.db, `UPDATE photos SET deleted_at = ? WHERE id = 'P0'`, new Date(NOW - 365 * 24 * 60 * 60 * 1000).toISOString());
    assert.deepEqual(await off.service.purgeExpired(), { purged: 0, skipped: 0, protected: 0, remoteFailures: 0 });
    assert.notEqual(off.repo.getDeleted('P0'), undefined, 'Off is manual-only');

    for (const retention of ['7', '30', '90'] as const) {
      const days = Number(retention);
      const w = await world(2, { retention });
      w.repo.softDelete(['P0', 'P1']);
      const cutoff = NOW - days * 24 * 60 * 60 * 1000;
      run(w.db, `UPDATE photos SET deleted_at = ? WHERE id = 'P0'`, new Date(cutoff).toISOString());
      run(w.db, `UPDATE photos SET deleted_at = ? WHERE id = 'P1'`, new Date(cutoff + 1).toISOString());

      const summary = await w.service.purgeExpired();
      assert.equal(summary.purged, 1, `${retention}-day cutoff includes the boundary`);
      assert.equal(w.repo.get('P0'), undefined);
      assert.notEqual(w.repo.getDeleted('P1'), undefined, 'one millisecond inside the window survives');
      assert.ok(w.audits.some((line) => line.includes(`days=${retention}`)));
    }
  });

  test('cancellation finishes the current destructive item and stops before the next row', async () => {
    const w = await world(2);
    w.repo.softDelete(['P0', 'P1']);
    const controller = new AbortController();
    const originalDelete = w.provider.delete.bind(w.provider);
    w.provider.delete = async (remotePath) => {
      controller.abort();
      await originalDelete(remotePath);
    };

    const summary = await w.service.purge(['P0', 'P1'], controller.signal);
    assert.equal(summary.purged, 1);
    assert.equal(w.repo.get('P0'), undefined, 'the active item completed its repairable delete order');
    assert.notEqual(w.repo.getDeleted('P1'), undefined, 'the next row was never admitted after cancellation');
    assert.deepEqual(w.changed, [['P0']]);
  });

  test('Original rows survive ordinary deletion and purge but authorized permanent deletion removes them', async () => {
    const w = await world(1);
    assert.deepEqual(w.repo.setOriginal(['P0'], true), { changed: ['P0'], unchanged: [], missing: [] });
    assert.deepEqual(w.repo.softDelete(['P0']), { deleted: [], protected: ['P0'], missing: [] });

    const ordinary = await w.service.purge(['P0']);
    assert.deepEqual(ordinary, { purged: 0, skipped: 1, protected: 0, remoteFailures: 0 });
    assert.notEqual(w.repo.get('P0'), undefined);

    const authorized = await w.service.deletePermanently(['P0']);
    assert.deepEqual(authorized, { purged: 1, skipped: 0, protected: 0, remoteFailures: 0 });
    assert.equal(w.repo.get('P0'), undefined);
  });
});
