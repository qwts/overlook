import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { EditRevisionRepository } from '../../src/main/db/edit-revision-repository.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { queryGet, run } from '../../src/main/db/sql.js';
import { VariantService, type VariantServiceDeps } from '../../src/main/library/variant-service.js';
import {
  EDIT_AUTHOR_PRODUCT,
  EDIT_REVISION_FORMAT_VERSION,
  IDENTITY_TRANSFORM,
  type EditOperation,
  type EditTransform,
} from '../../src/shared/library/edit-revision.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #496 / ADR-0031 §1 + §3: Duplicate creates a sibling variant over the same
// original — a new row, the source's head edit stack copied as the variant's
// own root revision, its own derivatives baked with that transform under its
// own key. The original bytes are never rewritten; a non-local original
// defers the bake and the row still exists. Promote is reversible metadata.

const HASH = 'c'.repeat(64);
const ROTATE: EditOperation = { type: 'rotate', version: 1, quarterTurns: 1 };

function photo(id: string): PhotoInsert {
  return {
    id,
    fileName: `${id}.JPG`,
    fileKind: 'jpeg',
    width: 30,
    height: 20,
    bytes: 42,
    contentHash: HASH,
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

interface Harness {
  readonly service: VariantService;
  readonly repo: PhotosRepository;
  readonly revisions: EditRevisionRepository;
  readonly baked: { photoId: string; derivativeKey: string; transform: EditTransform }[];
  readonly created: string[][];
  readonly changed: string[][];
  dirty(photoId: string): number | undefined;
}

function harness(overrides: Partial<VariantServiceDeps> = {}): Harness {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-variant-service-')), 'library.db'),
    dbKey: Buffer.alloc(32, 6),
  });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-14T20:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  repo.insert(photo('P1'));
  const revisions = new EditRevisionRepository(db);
  const baked: Harness['baked'] = [];
  const created: string[][] = [];
  const changed: string[][] = [];
  let seq = 0;
  const service = new VariantService({
    db,
    repo,
    loadOriginal: () => Promise.resolve(Buffer.from('original-bytes')),
    regenerate: (variant, _bytes, transform) => {
      baked.push({ photoId: variant.id, derivativeKey: variant.derivativeKey, transform });
      return Promise.resolve({ generated: true, width: 20, height: 30 });
    },
    appVersion: '0.0.0-test',
    newId: () => {
      seq += 1;
      return `01J8VRNT${String(seq).padStart(18, '0')}`;
    },
    now: () => `2026-09-02T10:00:${String(seq).padStart(2, '0')}.000Z`,
    created: (ids) => {
      created.push([...ids]);
    },
    changed: (ids) => {
      changed.push([...ids]);
    },
    ...overrides,
  });
  return {
    service,
    repo,
    revisions,
    baked,
    created,
    changed,
    dirty: (photoId) => queryGet<{ dirty: number }>(db, `SELECT dirty FROM sync_ledger WHERE photo_id = ?`, photoId)?.dirty,
  };
}

describe('VariantService (#496)', () => {
  test('Duplicate creates a sibling with its own key, the source head as its root revision, and bakes with it', async () => {
    const h = harness();
    h.revisions.append('P1', {
      version: EDIT_REVISION_FORMAT_VERSION,
      id: '01J8EDT000000000000000000A',
      parentId: null,
      operations: [ROTATE],
      author: { product: EDIT_AUTHOR_PRODUCT, version: '0.0.0-test' },
      createdAt: '2026-09-01T10:00:00.000Z',
      importedFrom: null,
    });
    const sourceHead = h.revisions.head('P1').head;
    assert.ok(sourceHead);

    const result = await h.service.duplicate(['P1']);

    assert.equal(result.created.length, 1);
    assert.equal(result.skipped, 0);
    const [entry] = result.created;
    assert.ok(entry);
    assert.equal(entry.sourceId, 'P1');
    assert.equal(entry.derivatives, 'regenerated');
    const variant = h.repo.get(entry.photoId);
    assert.ok(variant);
    assert.equal(variant.contentHash, HASH);
    assert.equal(variant.variantSourceId, 'P1');
    assert.notEqual(variant.derivativeKey, HASH);
    assert.deepEqual(h.baked, [{ photoId: variant.id, derivativeKey: variant.derivativeKey, transform: sourceHead.transform }]);
    const head = h.revisions.head(variant.id).head;
    assert.ok(head, 'the variant owns a root revision');
    assert.deepEqual(head.operations, [ROTATE]);
    assert.equal(head.parentId, null);
    assert.equal(h.revisions.head(variant.id).history.length, 1, 'history is the variant’s own, not the source’s');
    assert.equal(h.dirty(variant.id), 1, 'the ledger owes a backup');
    assert.deepEqual(h.created, [[variant.id]]);
    assert.equal(result.pendingCount, h.repo.pendingCount());
    assert.deepEqual(
      h.service.family('P1').variants.map((row) => row.id),
      ['P1', variant.id],
    );
  });

  test('an unedited source duplicates with an empty root and the identity transform', async () => {
    const h = harness();
    const result = await h.service.duplicate(['P1']);
    const [entry] = result.created;
    assert.ok(entry);
    assert.equal(h.revisions.head(entry.photoId).head, null);
    assert.deepEqual(
      h.baked.map((bake) => bake.transform),
      [IDENTITY_TRANSFORM],
    );
  });

  test('a head this build cannot evaluate refuses the Duplicate instead of baking an identity stand-in', async () => {
    const h = harness();
    h.revisions.append('P1', {
      version: EDIT_REVISION_FORMAT_VERSION,
      id: '01J8ED00000000000000000099',
      parentId: null,
      operations: [{ type: 'curve', version: 7 }],
      author: { product: EDIT_AUTHOR_PRODUCT, version: '9.9.9' },
      createdAt: '2026-09-01T09:00:00.000Z',
      importedFrom: null,
    });
    assert.notEqual(h.revisions.head('P1').head?.unsupported, null);
    const result = await h.service.duplicate(['P1']);
    assert.deepEqual(result.created, []);
    assert.deepEqual({ skipped: result.skipped, unsupported: result.unsupported }, { skipped: 0, unsupported: 1 });
    assert.deepEqual(h.baked, []);
    assert.deepEqual(h.created, []);
  });

  test('missing and trashed sources are skipped and counted, never duplicated', async () => {
    const h = harness();
    h.repo.insert({ ...photo('P2'), contentHash: 'd'.repeat(64) });
    h.repo.softDelete(['P2']);
    const result = await h.service.duplicate(['P2', 'ghost']);
    assert.deepEqual(result.created, []);
    assert.equal(result.skipped, 2);
    assert.deepEqual(h.created, []);
    assert.deepEqual(h.baked, []);
  });

  test('a non-local original defers the bake; the variant still exists and reports it', async () => {
    const h = harness({ loadOriginal: () => Promise.resolve(null) });
    const result = await h.service.duplicate(['P1']);
    const [entry] = result.created;
    assert.ok(entry);
    assert.equal(entry.derivatives, 'deferred');
    assert.ok(h.repo.get(entry.photoId));
    assert.deepEqual(h.baked, []);
    assert.deepEqual(h.created, [[entry.photoId]]);
  });

  test('a failed bake never loses the row', async () => {
    const h = harness({ regenerate: () => Promise.reject(new Error('sharp exploded')) });
    const result = await h.service.duplicate(['P1']);
    const [entry] = result.created;
    assert.ok(entry);
    assert.equal(entry.derivatives, 'failed');
    assert.ok(h.repo.get(entry.photoId));
  });

  test('Promote is reversible metadata that reports the family', async () => {
    const h = harness();
    const [entry] = (await h.service.duplicate(['P1'])).created;
    assert.ok(entry);
    let family = h.service.promote(entry.photoId);
    assert.equal(family.representativeId, entry.photoId);
    family = h.service.promote('P1');
    assert.equal(family.representativeId, 'P1');
    assert.deepEqual(h.changed, [
      ['P1', entry.photoId],
      ['P1', entry.photoId],
    ]);
    assert.throws(() => h.service.promote('ghost'), /not found/u);
  });
});
