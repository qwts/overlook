import { EditBakeDebtRepository } from '../../src/main/db/edit-bake-debt-repository.js';
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
import { queryGet, run } from '../../src/main/db/sql.js';
import { VariantService } from '../../src/main/library/variant-service.js';
import { createRawRepairRuntime } from '../../src/main/import/raw-repair-runtime.js';
import { ThumbnailPool } from '../../src/main/import/thumbnail-pool.js';
import { ThumbnailService } from '../../src/main/import/thumbnail-service.js';
import { EDIT_AUTHOR_PRODUCT, EDIT_REVISION_FORMAT_VERSION } from '../../src/shared/library/edit-revision.js';

for (const fileKind of ['jpeg', 'png'] as const) {
  test(`${fileKind} deferred variant survives restart and repairs its own transformed encrypted previews (#1121)`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'overlook-deferred-variant-'));
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
    revisions.append('root', {
      version: EDIT_REVISION_FORMAT_VERSION,
      id: '01J8EDT000000000000000000A',
      parentId: null,
      operations: [{ type: 'rotate', version: 1, quarterTurns: 1 }],
      author: { product: EDIT_AUTHOR_PRODUCT, version: 'test' },
      createdAt: '2026-09-21T00:00:00.000Z',
      importedFrom: null,
    });
    await blobs.deleteOriginal(original.contentHash);
    let seq = 0;
    const variantService = new VariantService({
      db,
      repo,
      appVersion: 'test',
      newId: () => `01J8VRNT${String(++seq).padStart(18, '0')}`,
      now: () => '2026-09-21T00:00:00.000Z',
      loadOriginal: () => Promise.resolve(null),
      regenerate: () => Promise.reject(new Error('must defer')),
      created: () => undefined,
      changed: () => undefined,
    });
    const result = await variantService.duplicate(['root']);
    const entry = result.created[0];
    assert.ok(entry);
    assert.equal(entry.derivatives, 'deferred');
    const id = entry.photoId;
    db.close();
    db = openLibraryDatabase(database);
    repo = new PhotosRepository(db);
    revisions = new EditRevisionRepository(db);
    const variant = repo.get(id);
    assert.ok(variant);
    assert.equal(variant.previewFailure, 'deferred-original');
    assert.equal(
      repo.previewRepairCandidates([original.contentHash]).some((photo) => photo.id === id),
      true,
    );
    const pool = new ThumbnailPool({ workerUrl: new URL('../../src/main/import/thumbnail-worker.js', import.meta.url), size: 1 });
    const changed: string[][] = [];
    const memberships: string[] = [];
    let keyPresent = true;
    const repair = createRawRepairRuntime({
      repo,
      revisions,
      bakeDebt: new EditBakeDebtRepository(db),
      blobs,
      blobsReady: Promise.resolve(),
      thumbnails: new ThumbnailService(pool, blobs),
      currentKey: () => key,
      resolveKey: () => {
        assert.ok(keyPresent, 'locked candidates must not attempt decryption');
        return key.key;
      },
      changed: (ids, membership) => {
        changed.push([...ids]);
        memberships.push(membership);
      },
    });
    try {
      await repair.repair([original.contentHash]);
      assert.equal(repo.get(id)?.previewFailure, 'deferred-original', 'missing original retains durable debt');
      await blobs.putOriginal(Readable.from([bytes]), key, 'root');
      await repair.repair([original.contentHash]);
      assert.equal(await blobs.verifyThumbs(variant.derivativeKey, () => key.key, id), true);
      const mid = await buffer(blobs.getThumbStream(variant.derivativeKey, 'mid', () => key.key, id));
      const metadata = await sharp(mid).metadata();
      assert.equal(metadata.width, 40);
      assert.equal(metadata.height, 60);
      assert.equal(repo.get(id)?.previewFailure, null);
      assert.equal(queryGet<{ pending: number }>(db, 'SELECT preview_repair_pending AS pending FROM photos WHERE id = ?', id)?.pending, 0);
      assert.equal(changed.flat().includes(id), true);
      assert.equal(memberships.at(-1), 'library');
      run(db, 'UPDATE photos SET preview_repair_pending = 1 WHERE id = ?', id);
      run(db, 'UPDATE keys SET material_present = 0 WHERE id = ?', key.id);
      keyPresent = false;
      assert.equal(repo.get(id)?.locked, true);
      const eventsBeforeLock = changed.length;
      await repair.repair([original.contentHash]);
      assert.equal(repo.get(id)?.previewFailure, null, 'locked verification cannot prove previews missing');
      assert.equal(queryGet<{ pending: number }>(db, 'SELECT preview_repair_pending AS pending FROM photos WHERE id = ?', id)?.pending, 1);
      assert.equal(changed.length, eventsBeforeLock);
      run(db, 'UPDATE keys SET material_present = 1 WHERE id = ?', key.id);
      keyPresent = true;
      assert.equal(repo.get(id)?.locked, false);
      assert.equal(repo.get(id)?.previewFailure, null, 'unlock needs no repair to undo a false missing state');
      await repair.repair([original.contentHash]);
      assert.equal(queryGet<{ pending: number }>(db, 'SELECT preview_repair_pending AS pending FROM photos WHERE id = ?', id)?.pending, 0);
      assert.equal(memberships.at(-1), 'none', 'later verification only clears debt');
      assert.equal(
        await blobs.verifyThumbs(original.contentHash, () => key.key, 'root'),
        true,
        'the edited root now also settles its own bake debt under its own authenticated address',
      );
    } finally {
      repair.close();
      await pool.close();
      db.close();
    }
  });
}
