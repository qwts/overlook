import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { createConsistencyChecker } from '../../src/main/library/consistency-factory.js';
import { createPurgeService } from '../../src/main/library/purge-factory.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { SidecarRepository } from '../../src/main/db/sidecar-repository.js';
import { run } from '../../src/main/db/sql.js';
import { sampleJpeg } from '../../src/main/library/seed.js';
import type { EnvelopeKey } from '../../src/main/crypto/envelope.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// Custody composition factories (#484): purge + consistency wired over REAL
// db/store/provider — the same seams index.ts hands them — proving sidecar
// custody deletes with the photo and the scan sees the sidecar namespace.

const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const XMP = Buffer.from('<x:xmpmeta>factory-test</x:xmpmeta>', 'utf8');

async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-factories-'));
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT OR IGNORE INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-01T00:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  const store = new BlobStore({ dataDir });
  await store.init();
  const key: EnvelopeKey = { id: 1, key: randomBytes(32) };
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-factories-remote-')) });

  const jpeg = sampleJpeg(1);
  const ref = await store.putOriginal(Readable.from([jpeg]), key, ULID_A);
  const sidecarRef = await store.putSidecar(Readable.from([XMP]), key, ULID_A);
  await provider.put(`blobs/${ref.contentHash.slice(0, 2)}/${ref.contentHash}`, store.getEncryptedStream(ref.contentHash));
  await provider.put(`sidecars/${ULID_A}/${sidecarRef.contentHash}`, store.getEncryptedSidecarStream(ULID_A, sidecarRef.contentHash));
  repo.insert({
    id: ULID_A,
    fileName: 'IMG_1.jpg',
    fileKind: 'jpeg',
    width: 1,
    height: 1,
    bytes: jpeg.length,
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
    importedAt: '2026-07-25T00:00:00.000Z',
    importSource: 'test',
    keyId: 1,
  } satisfies PhotoInsert);
  const sidecars = new SidecarRepository(db);
  sidecars.insert({
    photoId: ULID_A,
    role: 'xmp',
    fileName: 'IMG_1.xmp',
    contentHash: sidecarRef.contentHash,
    bytes: XMP.length,
    keyId: 1,
    importedAt: '2026-07-29T00:00:00.000Z',
  });
  return { db, repo, store, provider, sidecarRef, sidecars };
}

describe('custody composition factories (#484)', () => {
  test('ACCEPTANCE: purge removes the photo, its companion blob, and both remote objects', async () => {
    const w = await world();
    const audits: string[] = [];
    const service = createPurgeService({
      db: w.db,
      repo: w.repo,
      blobStore: w.store,
      remoteProvider: () => Promise.resolve(w.provider),
      custodyChanged: () => undefined,
      oweManifest: () => undefined,
      libraryChanged: () => undefined,
      audit: (line) => audits.push(line),
      retention: () => '30',
    });

    w.repo.softDelete([ULID_A]);
    const summary = await service.purge([ULID_A]);

    assert.equal(summary.purged, 1);
    assert.equal(summary.remoteFailures, 0);
    assert.equal(w.store.hasSidecar(ULID_A, w.sidecarRef.contentHash), false, 'companion blob deleted');
    assert.equal(w.sidecars.hasRowsForPhoto(ULID_A), false, 'companion rows cascaded');
    const remoteSidecars = await w.provider.list('sidecars');
    assert.deepEqual(remoteSidecars, [], 'remote companion object deleted');
  });

  test('the consistency scan sees owned companions and reports nothing for a healthy library', async () => {
    const w = await world();
    const checker = createConsistencyChecker({
      db: w.db,
      repo: w.repo,
      blobStore: w.store,
      provider: w.provider,
      setStatus: () => undefined,
      libraryChanged: () => undefined,
      audit: () => undefined,
    });
    const report = await checker.scan();
    assert.deepEqual(report.orphanSidecars, []);
    assert.deepEqual(report.orphanOriginals, []);
    assert.deepEqual(report.lyingRows, []);
  });
});
