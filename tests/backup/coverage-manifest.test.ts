import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  buildBackupManifestV14,
  parseBackupManifest,
  type BackupManifestSnapshotV14,
} from '../../src/main/backup/backup-manifest.js';
import { blobPhotos, coverageTotals, manifestBlobPath } from '../../src/main/backup/backup-manifest-coverage.js';
import { projectVerifiedManifest } from '../../src/main/backup/restore-projection.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #506 / ADR-0033 §4: schema 14 records an excluded photo without a blob
// path and carries derived totals the parser cross-checks, so recovery can
// count what the backup deliberately does not hold and restore creates an
// honest placeholder for it.

const LIBRARY = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const AT = '2026-09-02T00:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const KEYS = [{ id: 1, wrappedKey: 'test', createdAt: '2026-07-14T20:00:00.000Z', status: 'active' as const }];

function photo(id: string, contentHash: string, bytes: number): PhotoInsert {
  return {
    id,
    fileName: `${id}.JPG`,
    fileKind: 'jpeg',
    width: 30,
    height: 20,
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
    importedAt: '2026-07-14T21:00:00.000Z',
    importSource: 'camera',
    keyId: 1,
  };
}

function open(seeded: boolean): { photos: PhotosRepository; ledger: SyncLedger } {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-coverage-manifest-')), 'library.db'),
    dbKey: randomBytes(32),
  });
  const photos = new PhotosRepository(db);
  const ledger = new SyncLedger(db);
  if (seeded) {
    run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-14T20:00:00.000Z')`);
    photos.insert(photo('P1', HASH_A, 42));
    photos.insert(photo('P2', HASH_B, 58));
    ledger.markExcluding('P2', 'user', AT);
    ledger.markExcluded('P2');
  }
  return { photos, ledger };
}

function snapshotOf(photos: PhotosRepository): BackupManifestSnapshotV14 {
  return {
    ...photos.manifestSnapshot(),
    protectedAlbums: [],
    protectedPhotos: [],
    activity: [],
    boards: [],
    sidecars: [],
    galleryPolicy: photos.galleryPolicy(),
    hiddenAlbumIds: [],
    folders: [],
    albumTree: [],
    smartAlbums: [],
    editRevisions: [],
    provenance: [],
    variantFamilies: [],
  };
}

describe('backup coverage in the manifest (#506, schema 14)', () => {
  test('the snapshot records an excluded row without a blob path, and the builder derives the totals', () => {
    assert.equal(BACKUP_MANIFEST_SCHEMA_VERSION, 14);
    const { photos } = open(true);
    const snapshot = snapshotOf(photos);
    const [p1, p2] = snapshot.photos;
    assert.ok(p1 && p2);
    assert.equal('blobPath' in p1 && p1.blobPath, manifestBlobPath(HASH_A));
    assert.equal('coverage' in p1, false, 'an included record keeps its schema-13 shape');
    assert.equal('blobPath' in p2, false);
    assert.equal('coverage' in p2 && p2.coverage, 'excluded');

    const manifest = buildBackupManifestV14({ libraryId: LIBRARY, generatedAt: AT, snapshot });
    assert.equal(manifest.schema, 14);
    assert.deepEqual(manifest.coverage, { excludedCount: 1, excludedBytes: 58 });
    assert.deepEqual(coverageTotals(manifest.photos), manifest.coverage);
    assert.deepEqual(
      blobPhotos(manifest.photos).map((row) => row.id),
      ['P1'],
      'only carried records name a blob to verify',
    );

    const parsed = parseBackupManifest(JSON.parse(JSON.stringify(manifest)));
    assert.ok(parsed.restorable);
    assert.equal(parsed.manifest.schema, 14);
  });

  test('the parser rejects drifted totals and an excluded record that still names a blob', () => {
    const { photos } = open(true);
    const manifest = buildBackupManifestV14({ libraryId: LIBRARY, generatedAt: AT, snapshot: snapshotOf(photos) });
    const json = JSON.parse(JSON.stringify(manifest)) as { coverage: unknown; photos: Record<string, unknown>[] };
    assert.throws(() => parseBackupManifest({ ...json, coverage: { excludedCount: 0, excludedBytes: 0 } }), /invalid schema-14 manifest/u);
    assert.throws(
      () => parseBackupManifest({ ...json, photos: json.photos.map((row) => ({ ...row, blobPath: manifestBlobPath(HASH_B) })) }),
      /invalid schema-14 manifest/u,
    );
    assert.throws(
      () =>
        parseBackupManifest({
          ...json,
          photos: json.photos.map((row) => (row['id'] === 'P1' ? { ...row, blobPath: undefined } : row)),
        }),
      /invalid schema-14 manifest/u,
      'an included record without a blob path is not a valid manifest',
    );
  });

  test('restore recreates an excluded row as a placeholder that is honest about its state', () => {
    const source = open(true);
    const manifest = buildBackupManifestV14({ libraryId: LIBRARY, generatedAt: AT, snapshot: snapshotOf(source.photos) });
    const target = open(false);
    target.photos.restoreManifest(manifest, KEYS);
    const restored = target.photos.get('P2');
    assert.equal(restored?.coverage, 'excluded');
    assert.equal(restored?.syncState, 'error', 'no original anywhere: the row cannot claim a backup');
    assert.deepEqual(target.ledger.coverage('P2'), { coverage: 'excluded', origin: 'user', since: AT });
    assert.equal(target.photos.get('P1')?.coverage, 'included');
    assert.equal(target.photos.stats().excludedCount, 1);
    assert.equal(target.photos.pendingCount(), 0, 'a restored placeholder is not backup work');
  });

  test('a verified-only projection keeps the excluded rows and recomputes the totals', () => {
    const { photos } = open(true);
    const manifest = buildBackupManifestV14({ libraryId: LIBRARY, generatedAt: AT, snapshot: snapshotOf(photos) });
    const projected = projectVerifiedManifest(manifest, [
      { path: manifestBlobPath(HASH_A), kind: 'original', photoId: 'P1', reason: 'not-found' },
    ]);
    assert.deepEqual(
      projected.photos.map((row) => row.id),
      ['P2'],
    );
    assert.ok('coverage' in projected);
    assert.deepEqual(projected.coverage, { excludedCount: 1, excludedBytes: 58 });
  });
});
