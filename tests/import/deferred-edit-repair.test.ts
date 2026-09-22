import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';
import sharp from 'sharp';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { EditRevisionRepository } from '../../src/main/db/edit-revision-repository.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import { PhotoEditService } from '../../src/main/library/photo-edit-service.js';
import { createRawRepairRuntime } from '../../src/main/import/raw-repair-runtime.js';
import { ThumbnailPool } from '../../src/main/import/thumbnail-pool.js';
import { ThumbnailService } from '../../src/main/import/thumbnail-service.js';
import type { EditOperation } from '../../src/shared/library/edit-revision.js';

for (const fileKind of ['jpeg', 'png'] as const) {
  test(`${fileKind} deferred edit survives restart and replaces valid old encrypted previews when its original returns (#1115)`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'overlook-deferred-edit-'));
    const database = { path: join(dataDir, 'library.db'), dbKey: Buffer.alloc(32, 8) };
    let db = openLibraryDatabase(database);
    const blobs = new BlobStore({ dataDir });
    await blobs.init();
    const key = { id: 1, key: Buffer.alloc(32, 9) };
    const bytes = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#123456' } })
      .toFormat(fileKind)
      .toBuffer();
    const original = await blobs.putOriginal(Readable.from([bytes]), key, 'root');
    let repo = new PhotosRepository(db);
    run(db, "INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-09-21')");
    repo.insert({
      id: 'root',
      fileName: `root.${fileKind}`,
      fileKind,
      width: 60,
      height: 40,
      bytes: bytes.length,
      contentHash: original.contentHash,
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
      importedAt: '2026-09-21',
      importSource: 'test',
      keyId: 1,
    });
    repo.setDimensionStatus('root', 'verified');
    let revisions = new EditRevisionRepository(db);
    const pool = new ThumbnailPool({ workerUrl: new URL('../../src/main/import/thumbnail-worker.js', import.meta.url), size: 1 });
    const thumbnails = new ThumbnailService(pool, blobs);
    await thumbnails.generateFor({ photoId: 'root', bytes, contentHash: original.contentHash, key, fileKind });
    assert.equal(await blobs.verifyThumbs(original.contentHash, () => key.key, 'root'), true);
    await blobs.deleteOriginal(original.contentHash);
    run(db, "UPDATE sync_ledger SET status = 'offloaded' WHERE photo_id = 'root'");
    const service = new PhotoEditService({
      db,
      repo,
      appVersion: 'test',
      newId: () => '01J8EDT000000000000000000A',
      now: () => '2026-09-22T00:00:00.000Z',
      loadOriginal: () => Promise.resolve(null),
      regenerate: () => Promise.reject(new Error('must defer')),
      changed: () => undefined,
    });
    const edits: readonly EditOperation[] = [{ type: 'rotate', version: 1, quarterTurns: 1 }];
    const saved = await service.save('root', edits);
    assert.equal(saved.derivatives, 'deferred');
    const headId = saved.head?.id;
    assert.ok(headId);
    assert.equal(revisions.pendingBake('root'), headId);
    assert.equal((await service.save('root', edits)).changed, false, 'the identical save is still a no-op');
    const id = 'root';
    db.close();
    db = openLibraryDatabase(database);
    repo = new PhotosRepository(db);
    revisions = new EditRevisionRepository(db);
    const restored = repo.get(id);
    assert.ok(restored);
    assert.equal(restored.previewFailure, null, 'valid old previews are not missing');
    assert.equal(revisions.pendingBake(id), headId);
    assert.equal(
      repo.previewRepairCandidates([original.contentHash]).some((photo) => photo.id === id),
      true,
    );
    const changed: string[][] = [];
    const memberships: string[] = [];
    const repair = createRawRepairRuntime({
      repo,
      revisions,
      blobs,
      blobsReady: Promise.resolve(),
      thumbnails,
      currentKey: () => key,
      resolveKey: () => key.key,
      changed: (ids, membership) => {
        changed.push([...ids]);
        memberships.push(membership);
      },
    });
    try {
      await repair.repair([original.contentHash]);
      assert.equal(revisions.pendingBake(id), headId, 'missing original retains debt across startup');
      assert.equal(repo.get(id)?.previewFailure, null, 'old readable previews stay available');
      await blobs.putOriginal(Readable.from([bytes]), key, id);
      run(db, "UPDATE sync_ledger SET status = 'synced' WHERE photo_id = ?", id);
      await repair.repair([original.contentHash]);
      const mid = await buffer(blobs.getThumbStream(original.contentHash, 'mid', () => key.key, id));
      const metadata = await sharp(mid).metadata();
      assert.equal(metadata.width, 40);
      assert.equal(metadata.height, 60);
      assert.equal(revisions.pendingBake(id), undefined);
      assert.equal(revisions.head(id).head?.id, headId, 'repair never rewrites the durable edit head');
      assert.equal(revisions.head(id).history.length, 1);
      assert.equal(repo.get(id)?.previewFailure, null);
      assert.equal(changed.flat().includes(id), true);
      assert.equal(memberships.at(-1), 'none');
      assert.equal(repo.previewRepairCandidates([original.contentHash]).length, 0, 'the settled JPEG/PNG leaves maintenance');
    } finally {
      repair.close();
      await pool.close();
      db.close();
    }
  });
}
