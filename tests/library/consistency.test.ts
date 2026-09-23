import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { OriginalAvailabilityRepository } from '../../src/main/db/original-availability.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { ConsistencyChecker } from '../../src/main/library/consistency.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import { sampleJpeg } from '../../src/main/library/seed.js';
import type { EnvelopeKey } from '../../src/main/crypto/envelope.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #125: the library never lies after a crash. The checker detects
// DB↔blob↔ledger drift over the REAL store/repo/ledger/provider, repairs
// what is safe, and surfaces the rest. The import per-stage kill matrix
// lives in tests/import/import-engine.test.ts; backup mid-upload/mid-verify
// resume lives in tests/backup/backup-engine.test.ts — this file covers the
// offload/purge crash windows and the repair tool itself.

async function world(count: number) {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-consistency-'));
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT OR IGNORE INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-01T00:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  const ledger = new SyncLedger(db);
  const store = new BlobStore({ dataDir });
  await store.init();
  const key: EnvelopeKey = { id: 1, key: randomBytes(32) };
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-consistency-remote-')) });
  const hashes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = sampleJpeg(index);
    const ref = await store.putOriginal(Readable.from([bytes]), key, `P${String(index)}`);
    await store.putThumb(Readable.from([bytes]), key, `P${String(index)}`, ref.contentHash, 'thumb');
    hashes.push(ref.contentHash);
    repo.insert({
      id: `P${String(index)}`,
      fileName: `IMG_${String(index)}.JPG`,
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
      importedAt: '2026-07-01T00:00:00.000Z',
      importSource: 'test',
      keyId: 1,
    } satisfies PhotoInsert);
  }
  const audits: string[] = [];
  const changed: string[][] = [];
  const checker = new ConsistencyChecker({
    rows: () => repo.allRows(),
    blobs: {
      listOriginalHashes: async () => store.listOriginalHashes(),
      listThumbHashes: async () => store.listThumbHashes(),
      listStaged: async () => store.listStaged(),
      hasOriginal: (hash) => store.hasOriginal(hash),
      deleteOriginal: async (hash) => store.deleteOriginal(hash),
      deleteThumbs: async (hash) => store.deleteThumbs(hash),
      removeStaged: async (name) => store.removeStaged(name),
    },
    remoteHas: async (hash) => {
      try {
        await provider.verify(`blobs/${hash.slice(0, 2)}/${hash}`);
        return true;
      } catch {
        return false;
      }
    },
    setStatus: (photoId, status) => {
      new OriginalAvailabilityRepository(db).repair(photoId, status);
    },
    libraryChanged: (ids) => changed.push([...ids]),
    audit: (line) => audits.push(line),
  });
  return { dataDir, db, repo, ledger, store, provider, key, hashes, audits, changed, checker };
}

/** Back-date a published blob (+thumb) so the age gate treats it as a
 * leftover, not a live write (PR #223 review). */
function ageBlob(dataDir: string, hash: string): void {
  const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  utimesSync(join(dataDir, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash), old, old);
  utimesSync(join(dataDir, 'thumbs', hash.slice(0, 2), `${hash}.thumb`), old, old);
}

function emptyReport(report: {
  orphanOriginals: readonly string[];
  orphanThumbs: readonly string[];
  stagedLeftovers: readonly string[];
  lyingRows: readonly unknown[];
}): boolean {
  return (
    report.orphanOriginals.length === 0 &&
    report.orphanThumbs.length === 0 &&
    report.stagedLeftovers.length === 0 &&
    report.lyingRows.length === 0
  );
}

describe('consistency scan + repair (#125)', () => {
  test('a healthy library scans clean — trash rows still own their blobs', async () => {
    const w = await world(2);
    w.repo.softDelete(['P1']);
    assert.equal(emptyReport(await w.checker.scan()), true);
    w.db.close();
  });

  test('CRASH WINDOW offload (post-evict, pre-status): repair reconciles to offloaded and rehydrate works', async () => {
    const w = await world(1);
    const hash = w.hashes[0] ?? '';
    // The synced row's blob reached the remote; the crash hit between
    // deleteOriginal and setStatus('offloaded') in OffloadService.
    await w.provider.put(`blobs/${hash.slice(0, 2)}/${hash}`, w.store.getEncryptedStream(hash));
    run(w.db, `UPDATE sync_ledger SET status = 'synced', dirty = 0 WHERE photo_id = 'P0'`);
    await w.store.deleteOriginal(hash);

    const report = await w.checker.scan();
    assert.deepEqual(report.lyingRows, [{ photoId: 'P0', contentHash: hash, remoteBacked: true }]);

    const summary = await w.checker.repair();
    assert.equal(summary.repairedToOffloaded, 1);
    assert.equal(w.ledger.status('P0'), 'offloaded', 'an offload in disguise');
    assert.ok(w.audits.some((line) => line.startsWith('REPAIR-OFFLOADED photo=P0')));
    // Recoverability is REAL: the restore path brings the bytes back and
    // the machine resumes normally (offloaded → synced).
    await w.store.restoreOriginal(hash, await w.provider.getStream(`blobs/${hash.slice(0, 2)}/${hash}`), () => w.key.key, 'P0');
    assert.equal(w.store.hasOriginal(hash), true);
    w.ledger.setStatus('P0', 'synced');
    assert.equal(emptyReport(await w.checker.scan()), true, 'rescan is clean');
    w.db.close();
  });

  test('a lost blob (no copy anywhere) is marked error, never pretended away', async () => {
    const w = await world(1);
    const hash = w.hashes[0] ?? '';
    await w.store.deleteOriginal(hash);

    const summary = await w.checker.repair();
    assert.equal(summary.markedError, 1);
    assert.equal(w.ledger.status('P0'), 'error');
    assert.ok(w.audits.some((line) => line.startsWith('REPAIR-LOST photo=P0')));
    assert.deepEqual(w.changed, [['P0']], 'the red glyph gets its push');
    w.db.close();
  });

  test('CRASH WINDOW purge (row gone, blobs remain): repair removes the orphans', async () => {
    const w = await world(1);
    const hash = w.hashes[0] ?? '';
    // The crash hit after purgeRow, before the blob deletes.
    w.repo.softDelete(['P0']);
    w.repo.purgeRow('P0');
    ageBlob(w.dataDir, hash);

    const report = await w.checker.scan();
    assert.deepEqual(report.orphanOriginals, [hash]);
    assert.deepEqual(report.orphanThumbs, [hash]);

    await w.checker.repair();
    assert.equal(w.store.hasOriginal(hash), false);
    assert.equal(emptyReport(await w.checker.scan()), true, 'rescan is clean');
    w.db.close();
  });

  test('EXIT CRITERIA: a deliberately corrupted store repairs to consistency', async () => {
    const w = await world(3);
    const lostHash = w.hashes[0] ?? '';
    const orphanHash = w.hashes[2] ?? '';
    // Corruption 1: a lost blob (no remote copy).
    await w.store.deleteOriginal(lostHash);
    // Corruption 2: a purge interrupted after the row delete.
    w.repo.softDelete(['P2']);
    w.repo.purgeRow('P2');
    ageBlob(w.dataDir, orphanHash);
    // A FRESH published blob with no row yet (an import mid-flight —
    // putOriginal lands before repo.insert) must SURVIVE the repair.
    const liveRef = await w.store.putOriginal(Readable.from([sampleJpeg(777)]), w.key, 'LIVE');
    // Corruption 3: a crash mid-put strands staging ciphertext (old
    // mtime — the age gate must never reap LIVE staging writes).
    const stranded = join(w.dataDir, 'tmp', 'stranded.tmp');
    writeFileSync(stranded, randomBytes(64));
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(stranded, old, old);
    // A FRESH staging file (an in-flight put) must survive the repair.
    writeFileSync(join(w.dataDir, 'tmp', 'live.tmp'), randomBytes(64));

    const before = await w.checker.scan();
    assert.equal(before.lyingRows.length, 1);
    assert.deepEqual(before.orphanOriginals, [orphanHash]);
    assert.equal(before.stagedLeftovers.length, 1);

    await w.checker.repair();
    const after = await w.checker.scan();
    assert.equal(emptyReport({ ...after, lyingRows: [] }), true, 'repairable categories reconciled');
    assert.equal(after.lyingRows.length, 1, 'known missing originals remain observable on later scans');
    assert.deepEqual(
      (await w.store.listStaged()).map((entry) => entry.name),
      ['live.tmp'],
      'the in-flight staging write survived the repair (age gate)',
    );
    assert.equal(w.store.hasOriginal(liveRef.contentHash), true, 'the mid-import published blob survived (age gate)');
    assert.equal(w.ledger.status('P0'), 'error', 'the lost row is surfaced, not hidden');
    assert.notEqual(w.repo.get('P1'), undefined, 'healthy rows untouched');
    assert.equal(w.store.hasOriginal(w.hashes[1] ?? ''), true);
    w.db.close();
  });
});

test('legacy error rows are inspected while ordinary upload errors stay available (#1101)', async () => {
  const w = await world(2);
  try {
    w.ledger.repairStatus('P0', 'error');
    w.ledger.repairStatus('P1', 'error');
    await w.store.deleteOriginal(w.hashes[0] ?? '');
    const result = await w.checker.repair();
    assert.equal(result.markedError, 1);
    assert.equal(w.repo.get('P0')?.originalFailure, 'missing-original');
    assert.equal(w.repo.get('P1')?.originalFailure, null);
    assert.deepEqual(w.changed, [['P0']]);
    // A bare file appearing cannot clear durable evidence; recovery must
    // authenticate and verify its content address before clearing it.
    const hash = w.hashes[0] ?? '';
    writeFileSync(join(w.dataDir, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash), 'not an authenticated original');
    await w.checker.repair();
    assert.equal(w.repo.get('P0')?.originalFailure, 'missing-original');
  } finally {
    w.db.close();
  }
});
