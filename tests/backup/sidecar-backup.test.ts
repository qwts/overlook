import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { BackupEngine, sidecarBackupDeps, type BackupEngineDeps } from '../../src/main/backup/backup-engine.js';
import { createManifestDebtStore } from '../../src/main/backup/manifest-debt.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { claimsForContentHashes } from '../../src/main/db/backup-claims.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { SidecarRepository } from '../../src/main/db/sidecar-repository.js';
import { run } from '../../src/main/db/sql.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { sampleJpeg } from '../../src/main/library/seed.js';
import type { EnvelopeKey } from '../../src/main/crypto/envelope.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// Sidecar objects in the backup round trip (#484, PR #849 review): companions
// ride the owning photo's upload, manifests list only snapshot photos'
// companions, and reconciliation re-uploads a locally held companion the
// selected provider is missing instead of owing a manifest forever.

const XMP = Buffer.from('<x:xmpmeta>backup-test</x:xmpmeta>', 'utf8');

function photoInsert(id: string, contentHash: string, bytes: number): PhotoInsert {
  return {
    id,
    fileName: `${id}.jpg`,
    fileKind: 'jpeg',
    width: 1,
    height: 1,
    bytes,
    contentHash,
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
    importedAt: '2026-07-29T00:00:00.000Z',
    importSource: 'test',
    keyId: 1,
  };
}

async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-sidecar-backup-'));
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT OR IGNORE INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-13T00:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  const sidecars = new SidecarRepository(db);
  const store = new BlobStore({ dataDir });
  await store.init();
  const key: EnvelopeKey = { id: 1, key: randomBytes(32) };
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-sidecar-remote-')) });
  const ledger = new SyncLedger(db);
  let clock = 0;
  const deps: BackupEngineDeps = {
    provider,
    ledger,
    dirtyPhotos: () => repo.dirtyPhotos(),
    encryptedStream: (hash) => store.getEncryptedStream(hash),
    sealManifest: (json) => Promise.resolve(Buffer.from(json)),
    sealRecoveryBootstrap: () => Buffer.from('recovery-bootstrap'),
    libraryId: () => '01JZZZZZZZZZZZZZZZZZZZZZZZ',
    manifestSnapshot: () => repo.manifestSnapshot(),
    ...sidecarBackupDeps(db, store),
    settings: () => ({ throttlePercent: null, wifiOnly: false, autoBackupOnImport: false }),
    network: () => 'wifi',
    events: { progress: () => undefined },
    now: () => (clock += 40),
    sleep: () => Promise.resolve(),
    pendingCountChanged: () => undefined,
    pendingCount: () => repo.pendingCount(),
    syncStateChanged: () => undefined,
    audit: () => undefined,
    integrityScrub: () => Promise.resolve({ checked: 0, repaired: 0, unrecoverable: 0, cycleComplete: false }),
    recoveryGenerationHealthy: () => Promise.resolve(true),
    claimsForContentHashes: (hashes) => claimsForContentHashes(db, hashes),
    hasLocalOriginal: (hash) => store.hasOriginal(hash),
    manifestDebt: createManifestDebtStore(db),
  };

  async function addPhoto(id: string, seed: number, withSidecar: boolean): Promise<string | null> {
    const bytes = sampleJpeg(seed);
    const ref = await store.putOriginal(Readable.from([bytes]), key, id);
    repo.insert(photoInsert(id, ref.contentHash, ref.bytes));
    if (!withSidecar) return null;
    const sidecarRef = await store.putSidecar(Readable.from([XMP]), key, id);
    sidecars.insert({
      photoId: id,
      role: 'xmp',
      fileName: `${id}.xmp`,
      contentHash: sidecarRef.contentHash,
      bytes: sidecarRef.bytes,
      keyId: 1,
      importedAt: '2026-07-29T00:00:00.000Z',
    });
    return sidecarRef.contentHash;
  }

  async function latestManifest(): Promise<{ sidecars: { photoId: string; blobPath: string }[]; photos: { id: string }[] }> {
    const generations = await provider.list('manifest');
    const newest = [...generations].sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true })).at(-1);
    assert.ok(newest, 'a manifest generation exists');
    const sealed = await buffer(await provider.getStream(newest.path));
    return JSON.parse(sealed.toString('utf8')) as { sidecars: { photoId: string; blobPath: string }[]; photos: { id: string }[] };
  }

  return { deps, repo, store, ledger, provider, addPhoto, latestManifest, engine: new BackupEngine(deps) };
}

describe('sidecar backup round trip (#484)', () => {
  test('ACCEPTANCE: the companion uploads with its photo and lands in the schema-6 manifest; a deleted-unbacked photo stays out', async () => {
    const w = await world();
    const hash = await w.addPhoto('P0', 1, true);
    // Imported-with-sidecar then soft-deleted BEFORE any backup: its rows
    // must not poison the manifest (PR #849 review).
    await w.addPhoto('P1', 2, true);
    w.repo.softDelete(['P1']);

    const result = await w.engine.run();
    assert.deepEqual(
      { uploaded: result.uploaded, failed: result.failed, blocked: result.blockedRemoteOnly },
      { uploaded: 1, failed: 0, blocked: 0 },
    );
    assert.equal(result.manifestUploaded, true);

    const remote = await w.provider.list('sidecars');
    assert.deepEqual(
      remote.map((entry) => entry.path),
      [`sidecars/P0/${hash ?? ''}`],
      'only the recoverable photo uploads its companion',
    );
    const manifest = await w.latestManifest();
    assert.deepEqual(
      manifest.sidecars.map((sidecar) => sidecar.photoId),
      ['P0'],
    );
  });

  test('ADR-0033 §4 (PR #1124 review): an excluded photo keeps its record but its companion leaves the manifest', async () => {
    const w = await world();
    const hash = await w.addPhoto('P0', 1, true);
    await w.addPhoto('P1', 2, true);
    assert.equal((await w.engine.run()).manifestUploaded, true);
    assert.deepEqual((await w.latestManifest()).sidecars.map((sidecar) => sidecar.photoId).sort(), ['P0', 'P1']);

    // The coverage ceremony records the exclusion and owes a generation;
    // the generation that lands must not reference the companion the
    // settlement is about to delete.
    w.ledger.markExcluding('P0', 'user', '2026-09-02T04:00:00.000Z');
    w.engine.oweManifest();
    assert.equal((await w.engine.run()).manifestUploaded, true);
    const manifest = await w.latestManifest();
    assert.deepEqual(
      manifest.photos.map((photo) => photo.id).sort(),
      ['P0', 'P1'],
      'the excluded record is still carried for its metadata',
    );
    assert.deepEqual(
      manifest.sidecars.map((sidecar) => sidecar.photoId),
      ['P1'],
      `sidecars/P0/${hash ?? ''} is not promised by the recording generation`,
    );
  });

  test("REGRESSION (PR #849): a provider missing a clean photo's companion re-uploads it during reconciliation", async () => {
    const w = await world();
    const hash = await w.addPhoto('P0', 1, true);
    assert.equal((await w.engine.run()).manifestUploaded, true);

    // The remote loses the companion while the photo stays clean synced —
    // nothing dirties the ledger, so only the publication preflight's
    // reconciliation can repair it. A FRESH engine models the relaunch or
    // provider reselect that surfaces the loss (the in-process presence
    // cache is the integrity scrubber's territory, not this path's).
    await w.provider.delete(`sidecars/P0/${hash ?? ''}`);
    w.deps.manifestDebt?.save(true);

    const again = await new BackupEngine(w.deps).run();
    assert.equal(again.manifestUploaded, true, 'the owed generation publishes after the sidecar re-upload');
    assert.equal(again.blockedRemoteOnly, 0);
    const remote = await w.provider.list('sidecars');
    assert.deepEqual(
      remote.map((entry) => entry.path),
      [`sidecars/P0/${hash ?? ''}`],
    );
  });
});
