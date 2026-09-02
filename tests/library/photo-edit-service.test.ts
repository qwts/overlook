import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { EditRevisionRepository } from '../../src/main/db/edit-revision-repository.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import { PhotoEditService, type PhotoEditServiceDeps } from '../../src/main/library/photo-edit-service.js';
import type { EditOperation, EditTransform } from '../../src/shared/library/edit-revision.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #493 / ADR-0031 §2: Save appends a revision whose parent is the head and
// advances the head in one transaction; an identical stack is a no-op; Reset
// and Revert are new revisions (history is append-only); every head change
// re-bakes the derivatives and dirties the ledger, and a derivative failure
// never rolls the durable head back.

function photo(id: string): PhotoInsert {
  return {
    id,
    fileName: `${id}.JPG`,
    fileKind: 'jpeg',
    width: 30,
    height: 20,
    bytes: 42,
    contentHash: (id === 'P1' ? 'c' : 'd').repeat(64),
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
    importedAt: '2026-07-14T21:00:00.000Z',
    importSource: 'camera',
    keyId: 1,
  };
}

const ROTATE: EditOperation = { type: 'rotate', version: 1, quarterTurns: 1 };
const FLIP: EditOperation = { type: 'flip', version: 1, axis: 'horizontal' };

interface Harness {
  readonly ledger: SyncLedger;
  readonly service: PhotoEditService;
  readonly repo: PhotosRepository;
  readonly revisions: EditRevisionRepository;
  readonly baked: EditTransform[];
  readonly changes: { photoId: string; derivatives: string }[];
  close(): void;
}

function harness(overrides: Partial<PhotoEditServiceDeps> = {}): Harness {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-photo-edit-service-')), 'library.db'),
    dbKey: Buffer.alloc(32, 5),
  });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-14T20:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  repo.insert(photo('P1'));
  repo.insert(photo('P2'));
  const baked: EditTransform[] = [];
  const changes: { photoId: string; derivatives: string }[] = [];
  let seq = 0;
  const service = new PhotoEditService({
    db,
    repo,
    loadOriginal: () => Promise.resolve(Buffer.from('original-bytes')),
    regenerate: (_photo, _bytes, transform) => {
      baked.push(transform);
      return Promise.resolve({ generated: true, width: 20, height: 30 });
    },
    appVersion: '0.0.0-test',
    newId: () => {
      seq += 1;
      return `01J8ED${String(seq).padStart(20, '0')}`;
    },
    now: () => `2026-09-01T10:00:${String(seq).padStart(2, '0')}.000Z`,
    changed: (photoId, derivatives) => {
      changes.push({ photoId, derivatives });
    },
    ...overrides,
  });
  return { ledger: new SyncLedger(db), service, repo, revisions: new EditRevisionRepository(db), baked, changes, close: () => db.close() };
}

describe('photo edit service (#493)', () => {
  test('save appends a revision, advances the head, re-bakes derivatives, and dirties the ledger', async () => {
    const h = harness();
    // Fresh rows are born dirty; a backed-up photo is the interesting case.
    h.ledger.setStatus('P1', 'syncing');
    h.ledger.markBackedUp('P1', '2026-08-01T00:00:00.000Z');
    const pendingBefore = h.repo.pendingCount();
    const result = await h.service.save('P1', [ROTATE]);
    assert.equal(result.changed, true);
    assert.equal(result.derivatives, 'regenerated');
    assert.equal(result.head?.parentId, null);
    assert.deepEqual(result.head?.transform, { quarterTurns: 1, flipped: false, crop: null });
    assert.deepEqual(h.baked, [{ quarterTurns: 1, flipped: false, crop: null }]);
    assert.deepEqual(h.changes, [{ photoId: 'P1', derivatives: 'regenerated' }]);
    assert.equal(result.pendingCount, pendingBefore + 1, 'the photo is dirty for the next backup');
    assert.deepEqual(h.service.head('P1'), { photoId: 'P1', head: result.head, history: result.history });
    h.close();
  });

  test('saving the stack the head already holds writes nothing', async () => {
    const h = harness();
    const first = await h.service.save('P1', [ROTATE, FLIP]);
    const again = await h.service.save('P1', [ROTATE, FLIP]);
    assert.equal(again.changed, false);
    assert.equal(again.derivatives, 'unchanged');
    assert.equal(again.head?.id, first.head?.id);
    assert.equal(again.history.length, 1);
    assert.equal(h.baked.length, 1);
    const emptyReset = await h.service.reset('P2');
    assert.equal(emptyReset.changed, false, 'resetting the empty root is a no-op');
    assert.equal(emptyReset.head, null);
    h.close();
  });

  test('reset and revert are new revisions: history is append-only and revert copies the target stack', async () => {
    const h = harness();
    const first = await h.service.save('P1', [ROTATE]);
    const reset = await h.service.reset('P1');
    assert.deepEqual(reset.head?.operations, []);
    assert.equal(reset.head?.parentId, first.head?.id);
    assert.deepEqual(h.baked.at(-1), { quarterTurns: 0, flipped: false, crop: null });
    const firstId = first.head?.id ?? '';
    const reverted = await h.service.revert('P1', firstId);
    assert.equal(reverted.history.length, 3);
    assert.deepEqual(reverted.head?.operations, [ROTATE]);
    assert.equal(reverted.head?.parentId, reset.head?.id);
    assert.notEqual(reverted.head?.id, firstId, 'revert never rewrites or re-points to the old row');
    await assert.rejects(h.service.revert('P2', firstId), /does not belong/u);
    h.close();
  });

  test('an offloaded original defers the bake; a failed bake reports failure but keeps the head', async () => {
    const deferred = harness({ loadOriginal: () => Promise.resolve(null) });
    const deferredResult = await deferred.service.save('P1', [ROTATE]);
    assert.equal(deferredResult.derivatives, 'deferred');
    assert.equal(deferred.service.head('P1').head?.id, deferredResult.head?.id);
    deferred.close();

    const failing = harness({ regenerate: () => Promise.reject(new Error('worker crashed')) });
    const failedResult = await failing.service.save('P1', [ROTATE]);
    assert.equal(failedResult.derivatives, 'failed');
    assert.equal(failedResult.changed, true);
    assert.equal(failing.service.head('P1').head?.id, failedResult.head?.id, 'the revision stays authoritative');
    assert.deepEqual(failing.changes, [{ photoId: 'P1', derivatives: 'failed' }]);
    failing.close();
  });

  test('operations are validated and unsupported revisions cannot be reverted to', async () => {
    const h = harness();
    await assert.rejects(h.service.save('P1', [{ type: 'rotate', version: 1, quarterTurns: 4 } as unknown as EditOperation]));
    const foreign = { type: 'curve', version: 7 } as unknown as EditOperation;
    const row = h.revisions.append('P1', {
      version: 1,
      id: '01J8ED00000000000000000099',
      parentId: null,
      operations: [foreign],
      author: { product: 'overlook', version: '9.9.9' },
      createdAt: '2026-09-01T09:00:00.000Z',
      importedFrom: null,
    });
    assert.notEqual(h.service.head('P1').head?.unsupported, null);
    await assert.rejects(h.service.revert('P1', row.id), /unsupported/u);
    // Saving over an unsupported head is allowed: the new revision is evaluable again.
    const saved = await h.service.save('P1', [ROTATE]);
    assert.equal(saved.head?.unsupported, null);
    assert.equal(saved.head?.parentId, row.id);
    h.close();
  });
});
