import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  buildBackupManifestV11,
  buildBackupManifestV12,
  parseBackupManifest,
  type BackupManifestSnapshotV12,
} from '../../src/main/backup/backup-manifest.js';
import type { BackupManifestProvenanceV12 } from '../../src/main/backup/backup-manifest-provenance.js';
import { provenanceMatches, restoreProvenance } from '../../src/main/backup/restore-provenance.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { ProvenanceRepository } from '../../src/main/db/provenance-repository.js';
import { run } from '../../src/main/db/sql.js';
import { buildProvenanceEvidence } from '../../src/shared/library/provenance.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #495 / ADR-0031 §7: provenance evidence is library data. Schema 12
// carries the record of every carried photo exactly as written; restore
// validates the links, writes the records unchanged, and verifies them.
// Older manifests restore with no records — evaluation happens lazily —
// never with invented ones.

const LIBRARY = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const AT = '2026-09-02T00:00:00.000Z';

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

function open(): { db: ReturnType<typeof openLibraryDatabase>; photos: PhotosRepository; provenance: ProvenanceRepository } {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-provenance-manifest-')), 'library.db'),
    dbKey: Buffer.alloc(32, 4),
  });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-14T20:00:00.000Z')`);
  const photos = new PhotosRepository(db);
  photos.insert(photo('P1'));
  photos.insert(photo('P2'));
  return { db, photos, provenance: new ProvenanceRepository(db) };
}

function snapshotOf(photos: PhotosRepository, provenance: readonly BackupManifestProvenanceV12[]): BackupManifestSnapshotV12 {
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
    provenance,
  };
}

const record = (photoId: string, subjectHash: string): BackupManifestProvenanceV12 => {
  const evidence = buildProvenanceEvidence({
    subjectHash,
    evaluatedAt: AT,
    sources: [{ kind: 'declaration', origin: 'xmp', field: 'xmp:CreatorTool', value: 'Adobe Firefly', claim: 'generated' }],
  });
  return { photoId, subjectHash, evaluator: evidence.evaluator, evaluatedAt: AT, tier: evidence.tier, document: evidence };
};

describe('provenance in the backup manifest (#495, schema 12)', () => {
  test('the current schema is 12 and carries provenance records as written', () => {
    assert.equal(BACKUP_MANIFEST_SCHEMA_VERSION, 12);
    const { photos } = open();
    const carried = [record('P1', 'a'.repeat(64))];
    const manifest = buildBackupManifestV12({ libraryId: LIBRARY, generatedAt: AT, snapshot: snapshotOf(photos, carried) });
    assert.equal(manifest.schema, 12);
    assert.deepEqual(manifest.provenance, carried);
    const parsed = parseBackupManifest(JSON.parse(JSON.stringify(manifest)));
    assert.ok(parsed.restorable);
    assert.ok('provenance' in parsed.manifest);
    assert.deepEqual(parsed.manifest.provenance, carried);
  });

  test('link checks: a record for an uncarried photo or two records for one photo are rejected', () => {
    const { photos } = open();
    const build = (provenance: readonly BackupManifestProvenanceV12[]): void => {
      buildBackupManifestV12({ libraryId: LIBRARY, generatedAt: AT, snapshot: snapshotOf(photos, provenance) });
    };
    assert.throws(() => build([record('ghost', 'c'.repeat(64))]), /does not carry/u);
    assert.throws(() => build([record('P1', 'a'.repeat(64)), record('P1', 'a'.repeat(64))]), /two provenance records/u);
    assert.throws(() => build([{ ...record('P1', 'a'.repeat(64)), document: { tier: 'verified' } }]), /integer version/u);
  });

  test('a schema-11 manifest still parses and a schema-12 manifest missing provenance does not', () => {
    const { photos } = open();
    const { provenance: _provenance, ...v11Snapshot } = snapshotOf(photos, []);
    const v11 = buildBackupManifestV11({ libraryId: LIBRARY, generatedAt: AT, snapshot: v11Snapshot });
    assert.equal(v11.schema, 11);
    const parsed = parseBackupManifest(JSON.parse(JSON.stringify(v11)));
    assert.ok(parsed.restorable);
    assert.equal('provenance' in parsed.manifest, false);
    assert.throws(() => parseBackupManifest({ ...v11, schema: 12 }), /invalid schema-12 manifest/u);
  });

  test('restore writes the records unchanged (a newer format included) and verifies them; older manifests restore none', () => {
    const source = open();
    source.provenance.put(
      'P1',
      buildProvenanceEvidence({
        subjectHash: 'a'.repeat(64),
        evaluatedAt: AT,
        sources: [
          {
            kind: 'credential',
            format: 'c2pa',
            container: 'jpeg-app11',
            bytes: 900,
            outcome: 'unverifiable',
            validator: null,
            reason: 'no validator',
          },
        ],
      }),
    );
    const future = { version: 5, subjectHash: 'b'.repeat(64), evaluator: 'future/1', evaluatedAt: AT, tier: 'verified' };
    source.provenance.restore([
      { photoId: 'P2', subjectHash: 'b'.repeat(64), evaluator: 'future/1', evaluatedAt: AT, tier: 'verified', document: future },
    ]);
    const snapshot = source.provenance.snapshot(new Set(['P1', 'P2']));
    assert.equal(snapshot.length, 2);
    const manifest = buildBackupManifestV12({ libraryId: LIBRARY, generatedAt: AT, snapshot: snapshotOf(source.photos, snapshot) });

    const target = open();
    assert.equal(provenanceMatches(target.db, manifest), false);
    restoreProvenance(target.db, manifest);
    assert.equal(provenanceMatches(target.db, manifest), true);
    assert.equal(target.provenance.get('P1')?.evidence?.tier, 'declared');
    assert.deepEqual(target.provenance.get('P2')?.document, future);
    assert.match(target.provenance.get('P2')?.unsupported ?? '', /newer/u);

    const legacy = open();
    const { provenance: _provenance, ...v11Snapshot } = snapshotOf(legacy.photos, []);
    const v11 = buildBackupManifestV11({ libraryId: LIBRARY, generatedAt: AT, snapshot: v11Snapshot });
    restoreProvenance(legacy.db, v11);
    assert.equal(legacy.provenance.snapshot(new Set(['P1', 'P2'])).length, 0);
    assert.equal(provenanceMatches(legacy.db, v11), true);
  });
});
