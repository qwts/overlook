import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  buildBackupManifestV10,
  buildBackupManifestV11,
  parseBackupManifest,
  type BackupManifestSnapshotV11,
} from '../../src/main/backup/backup-manifest.js';
import type { BackupManifestEditRevisionV11 } from '../../src/main/backup/backup-manifest-edit-revisions.js';
import { editRevisionsMatch, restoreEditRevisions, restoredHeadTransforms } from '../../src/main/backup/restore-edit-revisions.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { EditRevisionRepository } from '../../src/main/db/edit-revision-repository.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import { foldOperations, type EditOperation, type EditRevisionDocument } from '../../src/shared/library/edit-revision.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #493 / ADR-0031 §7: edit revisions are library data. Schema 11 carries
// every retained revision of every carried photo exactly as written, with
// the head flagged; restore validates the links, writes the documents
// unchanged, and verifies the chain. Older manifests restore with no
// revisions — the empty root (§8) — never with invented ones.

const LIBRARY = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const AT = '2026-09-01T00:00:00.000Z';

function photo(id: string): PhotoInsert {
  return {
    id,
    fileName: `${id}.JPG`,
    fileKind: 'jpeg',
    width: 30,
    height: 20,
    bytes: 42,
    contentHash: (id === 'P1' ? 'a' : 'b').repeat(64),
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

function open(): { db: ReturnType<typeof openLibraryDatabase>; photos: PhotosRepository; revisions: EditRevisionRepository } {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-edit-manifest-')), 'library.db'),
    dbKey: Buffer.alloc(32, 3),
  });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-14T20:00:00.000Z')`);
  const photos = new PhotosRepository(db);
  photos.insert(photo('P1'));
  photos.insert(photo('P2'));
  return { db, photos, revisions: new EditRevisionRepository(db) };
}

let seq = 0;
function document(parentId: string | null, operations: readonly EditOperation[]): EditRevisionDocument {
  seq += 1;
  return {
    version: 1,
    id: `01J8ED${String(seq).padStart(20, '0')}`,
    parentId,
    operations,
    author: { product: 'overlook', version: '0.0.0-test' },
    createdAt: `2026-09-01T10:00:${String(seq).padStart(2, '0')}.000Z`,
    importedFrom: null,
  };
}

const ROTATE: EditOperation = { type: 'rotate', version: 1, quarterTurns: 1 };

function snapshotOf(photos: PhotosRepository, editRevisions: readonly BackupManifestEditRevisionV11[]): BackupManifestSnapshotV11 {
  return {
    ...photos.manifestSnapshot(),
    protectedAlbums: [],
    protectedPhotos: [],
    activity: [],
    boards: [],
    sidecars: [],
    galleryPolicy: { showUnavailable: true, minimumMegapixels: null },
    hiddenAlbumIds: [],
    folders: [],
    albumTree: [],
    smartAlbums: [],
    editRevisions,
  };
}

describe('edit revisions in backup manifests (#493)', () => {
  test('schema 11 carries every revision as written, head flagged, and round-trips through the parser', () => {
    assert.equal(BACKUP_MANIFEST_SCHEMA_VERSION, 13);
    const { db, photos, revisions } = open();
    const first = revisions.append('P1', document(null, [ROTATE]));
    revisions.append('P1', document(first.id, []));
    const foreign = { type: 'curve', version: 9, points: [1, 2] } as unknown as EditOperation;
    revisions.append('P2', document(null, [foreign]));
    const carried = revisions.snapshot(new Set(['P1', 'P2']));
    const manifest = buildBackupManifestV11({ libraryId: LIBRARY, generatedAt: AT, snapshot: snapshotOf(photos, carried) });
    assert.equal(manifest.schema, 11);
    const parsed = parseBackupManifest(JSON.parse(JSON.stringify(manifest)));
    assert.ok(parsed.restorable);
    assert.ok('editRevisions' in parsed.manifest);
    assert.deepEqual(parsed.manifest.editRevisions, carried, 'a version-9 operation is carried, not rejected');
    assert.deepEqual(
      parsed.manifest.editRevisions.filter((revision) => revision.current).map((revision) => revision.photoId),
      ['P1', 'P2'],
    );
    db.close();
  });

  test('links are validated: carried photo, same-photo parent, unique ids, one head per photo', () => {
    const { db, photos, revisions } = open();
    const first = revisions.append('P1', document(null, [ROTATE]));
    const carried = revisions.snapshot(new Set(['P1']));
    const build = (editRevisions: readonly BackupManifestEditRevisionV11[]) =>
      buildBackupManifestV11({ libraryId: LIBRARY, generatedAt: AT, snapshot: snapshotOf(photos, editRevisions) });
    const [only] = carried;
    assert.ok(only !== undefined);
    assert.throws(() => build([{ ...only, photoId: 'ghost' }]), /does not carry/u);
    assert.throws(() => build([only, { ...only, id: 'X', parentId: first.id, photoId: 'P2' }]), /same photo/u);
    assert.throws(() => build([only, only]), /duplicate revision id/u);
    assert.throws(() => build([only, { ...only, id: 'Y' }]), /two current/u);
    assert.throws(() => build([{ ...only, document: { operations: [] } }]), /integer version/u);
    db.close();
  });

  test('a schema-10 manifest still parses and restores with no revisions (the empty root)', () => {
    const { db, photos } = open();
    const { editRevisions: _revisions, ...v10Snapshot } = snapshotOf(photos, []);
    const v10 = buildBackupManifestV10({ libraryId: LIBRARY, generatedAt: AT, snapshot: v10Snapshot });
    assert.equal(v10.schema, 10);
    const parsed = parseBackupManifest(v10);
    assert.ok(parsed.restorable);
    assert.ok(!('editRevisions' in parsed.manifest));
    restoreEditRevisions(db, parsed.manifest);
    assert.ok(editRevisionsMatch(db, parsed.manifest));
    assert.throws(() => parseBackupManifest({ ...v10, schema: 11 }), /invalid schema-11 manifest/u);
    db.close();
  });

  test('restore writes the chain unchanged into a fresh library and verifies it', () => {
    const source = open();
    const first = source.revisions.append('P1', document(null, [ROTATE]));
    source.revisions.append('P1', document(first.id, []));
    const manifest = buildBackupManifestV11({
      libraryId: LIBRARY,
      generatedAt: AT,
      snapshot: snapshotOf(source.photos, source.revisions.snapshot(new Set(['P1', 'P2']))),
    });
    const parsed = parseBackupManifest(JSON.parse(JSON.stringify(manifest)));
    assert.ok(parsed.restorable);

    const target = open();
    assert.ok(!editRevisionsMatch(target.db, parsed.manifest), 'an empty library does not match a manifest with revisions');
    restoreEditRevisions(target.db, parsed.manifest);
    assert.ok(editRevisionsMatch(target.db, parsed.manifest));
    assert.deepEqual(target.revisions.head('P1'), source.revisions.head('P1'));
    target.revisions.append('P2', document(null, [ROTATE]));
    assert.ok(!editRevisionsMatch(target.db, parsed.manifest), 'an extra revision is a mismatch');
    source.db.close();
    target.db.close();
  });
  test('restore bakes the head transform into rebuilt derivatives, skipping empty and unbakeable heads', () => {
    const { db, photos, revisions } = open();
    const first = revisions.append('P1', document(null, [ROTATE]));
    revisions.append('P1', document(first.id, [ROTATE, ROTATE]));
    const foreign = { type: 'curve', version: 9, points: [1, 2] } as unknown as EditOperation;
    revisions.append('P2', document(null, [foreign]));
    const carried = revisions.snapshot(new Set(['P1', 'P2']));
    const manifest = buildBackupManifestV11({ libraryId: LIBRARY, generatedAt: AT, snapshot: snapshotOf(photos, carried) });
    const parsed = parseBackupManifest(JSON.parse(JSON.stringify(manifest)));
    assert.ok(parsed.restorable);
    const transforms = restoredHeadTransforms(parsed.manifest);
    assert.deepEqual(transforms.get('P1'), foldOperations([ROTATE, ROTATE]), 'the head, not the first revision, is what bakes');
    assert.equal(transforms.has('P2'), false, 'a head this build cannot bake rebuilds from the untouched original');

    const reverted = revisions.append('P1', document(null, []));
    assert.equal(reverted.parentId, null);
    const back = parseBackupManifest(
      JSON.parse(
        JSON.stringify(
          buildBackupManifestV11({
            libraryId: LIBRARY,
            generatedAt: AT,
            snapshot: snapshotOf(photos, revisions.snapshot(new Set(['P1']))),
          }),
        ),
      ),
    );
    assert.ok(back.restorable);
    assert.equal(restoredHeadTransforms(back.manifest).has('P1'), false, 'an empty head is the untouched original');
    const { editRevisions: _revisions, ...tenSnapshot } = snapshotOf(photos, []);
    const ten = buildBackupManifestV10({ libraryId: LIBRARY, generatedAt: AT, snapshot: tenSnapshot });
    const legacy = parseBackupManifest(JSON.parse(JSON.stringify(ten)));
    assert.ok(legacy.restorable);
    assert.equal(restoredHeadTransforms(legacy.manifest).size, 0);
    db.close();
  });
});
