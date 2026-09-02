import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  buildBackupManifestV12,
  buildBackupManifestV13,
  parseBackupManifest,
  type BackupManifestSnapshotV13,
} from '../../src/main/backup/backup-manifest.js';
import { asCarriedRecords, manifestBlobPath } from '../../src/main/backup/backup-manifest-coverage.js';
import type { BackupManifestVariantFamilyV13 } from '../../src/main/backup/backup-manifest-variants.js';
import { projectVerifiedManifest } from '../../src/main/backup/restore-projection.js';
import { manifestDerivativeKey, restoreVariantFamilies, variantFamiliesMatch } from '../../src/main/backup/restore-variants.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import { VariantRepository, variantDerivativeKey } from '../../src/main/db/variant-repository.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #496 / ADR-0031 §7: variants are library data. Schema 13 carries each
// photo's derivative key and lineage (omitted when default, so a root
// variant's record keeps its schema-12 byte shape) plus the Promoted
// representative per asset; restore recreates the rows with their keys,
// writes the families, and verifies them. Older manifests restore every
// photo as a root variant with no families — never invented ones.

const LIBRARY = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const AT = '2026-09-02T00:00:00.000Z';
const HASH = 'a'.repeat(64);
const KEYS = [{ id: 1, wrappedKey: 'test', createdAt: '2026-07-14T20:00:00.000Z', status: 'active' as const }];

function photo(id: string): PhotoInsert {
  return {
    id,
    fileName: 'IMG_0001.JPG',
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

function open(mode: 'empty' | 'keyed' | 'seeded'): {
  db: ReturnType<typeof openLibraryDatabase>;
  photos: PhotosRepository;
  variants: VariantRepository;
} {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-variants-manifest-')), 'library.db'),
    dbKey: Buffer.alloc(32, 4),
  });
  if (mode !== 'empty') run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-14T20:00:00.000Z')`);
  const photos = new PhotosRepository(db);
  const variants = new VariantRepository(db);
  if (mode === 'seeded') {
    photos.insert(photo('P1'));
    const source = photos.get('P1');
    assert.ok(source);
    variants.duplicate(source, 'P2', AT);
    variants.promote(HASH, 'P2');
  }
  return { db, photos, variants };
}

function snapshotOf(photos: PhotosRepository, variantFamilies: readonly BackupManifestVariantFamilyV13[]): BackupManifestSnapshotV13 {
  const { photos: rows, ...rest } = photos.manifestSnapshot();
  return {
    ...rest,
    photos: asCarriedRecords(rows),
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
    variantFamilies,
  };
}

describe('variants in the backup manifest (#496, schema 13)', () => {
  test('schema 13 is restorable; roots keep their schema-12 shape, duplicates carry key and lineage, families ride along', () => {
    assert.ok(BACKUP_MANIFEST_SCHEMA_VERSION >= 13, 'schema 14 (#506) builds on this shape');
    const { photos, variants } = open('seeded');
    const families = variants.familiesSnapshot();
    const manifest = buildBackupManifestV13({ libraryId: LIBRARY, generatedAt: AT, snapshot: snapshotOf(photos, families) });
    assert.equal(manifest.schema, 13);
    const [root, duplicate] = manifest.photos;
    assert.ok(root && duplicate);
    assert.equal(root.id, 'P1');
    assert.equal('derivativeKey' in root, false);
    assert.equal('variantSourceId' in root, false);
    assert.equal(manifestDerivativeKey(root), HASH);
    assert.equal(duplicate.derivativeKey, variantDerivativeKey('P2', HASH));
    assert.equal(duplicate.variantSourceId, 'P1');
    assert.equal(duplicate.contentHash, HASH, 'one original, two rows');
    assert.deepEqual(manifest.variantFamilies, [{ contentHash: HASH, representativeId: 'P2' }]);
    const parsed = parseBackupManifest(JSON.parse(JSON.stringify(manifest)));
    assert.ok(parsed.restorable);
    assert.ok('variantFamilies' in parsed.manifest);
    assert.deepEqual(parsed.manifest.variantFamilies, manifest.variantFamilies);
  });

  test('link checks: a representative that is not a carried variant of its asset, or two rows on one key, are rejected', () => {
    const { photos } = open('seeded');
    const build = (families: readonly BackupManifestVariantFamilyV13[]): void => {
      buildBackupManifestV13({ libraryId: LIBRARY, generatedAt: AT, snapshot: snapshotOf(photos, families) });
    };
    assert.throws(() => build([{ contentHash: HASH, representativeId: 'ghost' }]), /not a carried variant/u);
    assert.throws(() => build([{ contentHash: 'b'.repeat(64), representativeId: 'P1' }]), /not a carried variant/u);
    assert.throws(
      () =>
        build([
          { contentHash: HASH, representativeId: 'P1' },
          { contentHash: HASH, representativeId: 'P2' },
        ]),
      /listed twice/u,
    );
    const snapshot = snapshotOf(photos, []);
    assert.throws(
      () =>
        buildBackupManifestV13({
          libraryId: LIBRARY,
          generatedAt: AT,
          snapshot: { ...snapshot, photos: snapshot.photos.map((row) => ({ ...row, derivativeKey: HASH })) },
        }),
      /not unique/u,
    );
  });

  test('a representative trashed before its first backup is not carried, so the manifest still builds', () => {
    const { photos, variants } = open('seeded');
    photos.softDelete(['P2']);
    assert.deepEqual(variants.familiesSnapshot(), [], 'the manifest does not list P2, so no family may name it');
    const manifest = buildBackupManifestV13({
      libraryId: LIBRARY,
      generatedAt: AT,
      snapshot: snapshotOf(photos, variants.familiesSnapshot()),
    });
    assert.deepEqual(
      manifest.photos.map((row) => row.id),
      ['P1'],
    );
    assert.deepEqual(manifest.variantFamilies, []);
    assert.equal(variants.representative(HASH), 'P2', 'Promote itself is untouched; only the snapshot omits it');
  });

  test('a verified-only projection drops the family of a lost original along with its variants', () => {
    const { photos, variants } = open('seeded');
    const manifest = buildBackupManifestV13({
      libraryId: LIBRARY,
      generatedAt: AT,
      snapshot: snapshotOf(photos, variants.familiesSnapshot()),
    });
    const parsed = parseBackupManifest(JSON.parse(JSON.stringify(manifest)));
    assert.ok(parsed.restorable);
    const [root, duplicate] = parsed.manifest.photos;
    assert.ok(root && duplicate);
    const projected = projectVerifiedManifest(parsed.manifest, [
      { path: manifestBlobPath(root.contentHash), kind: 'original', photoId: root.id, reason: 'not-found' },
      { path: manifestBlobPath(duplicate.contentHash), kind: 'original', photoId: duplicate.id, reason: 'not-found' },
    ]);
    assert.deepEqual(projected.photos, []);
    assert.ok('variantFamilies' in projected);
    assert.deepEqual(projected.variantFamilies, [], 'no representative survives, so no family may dangle');
    // Losing nothing keeps the family.
    const intact = projectVerifiedManifest(parsed.manifest, []);
    assert.ok('variantFamilies' in intact);
    assert.deepEqual(intact.variantFamilies, [{ contentHash: HASH, representativeId: 'P2' }]);
  });

  test('a schema-12 manifest still parses without families, and schema 13 without them does not', () => {
    const { photos } = open('keyed');
    photos.insert(photo('P1'));
    const { variantFamilies: _families, ...v12Snapshot } = snapshotOf(photos, []);
    const v12 = buildBackupManifestV12({ libraryId: LIBRARY, generatedAt: AT, snapshot: v12Snapshot });
    assert.equal(v12.schema, 12);
    const parsed = parseBackupManifest(JSON.parse(JSON.stringify(v12)));
    assert.ok(parsed.restorable);
    assert.equal('variantFamilies' in parsed.manifest, false);
    assert.throws(() => parseBackupManifest({ ...v12, schema: 13 }), /invalid schema-13 manifest/u);
  });

  test('restore recreates the rows under their own keys, writes the families, and verifies them; older manifests restore none', () => {
    const source = open('seeded');
    const manifest = buildBackupManifestV13({
      libraryId: LIBRARY,
      generatedAt: AT,
      snapshot: snapshotOf(source.photos, source.variants.familiesSnapshot()),
    });

    const target = open('empty');
    target.photos.restoreManifest(manifest, KEYS);
    assert.equal(target.photos.get('P1')?.derivativeKey, HASH);
    assert.equal(target.photos.get('P2')?.derivativeKey, variantDerivativeKey('P2', HASH));
    assert.equal(target.photos.get('P2')?.variantSourceId, 'P1');
    assert.equal(target.photos.get('P2')?.assetOwnerId, 'P1', 'the envelope binding restores with the row');
    assert.equal(target.photos.get('P1')?.assetOwnerId, null);
    assert.equal(target.photos.countAnyByContentHash(HASH), 2);
    assert.equal(variantFamiliesMatch(target.db, manifest), false);
    restoreVariantFamilies(target.db, manifest);
    assert.equal(variantFamiliesMatch(target.db, manifest), true);
    assert.equal(target.variants.representative(HASH), 'P2');
    target.variants.promote(HASH, 'P1');
    assert.equal(variantFamiliesMatch(target.db, manifest), false, 'a drifted family is a mismatch, not a partial restore');

    // A schema-12 library knew one row per asset: every photo restores as
    // the root variant of its hash, and no family is invented.
    const rootOnly = open('keyed');
    rootOnly.photos.insert(photo('P1'));
    const { variantFamilies: _families, ...v12Snapshot } = snapshotOf(rootOnly.photos, []);
    const v12 = buildBackupManifestV12({ libraryId: LIBRARY, generatedAt: AT, snapshot: v12Snapshot });
    const legacy = open('empty');
    legacy.photos.restoreManifest(v12, KEYS);
    restoreVariantFamilies(legacy.db, v12);
    assert.deepEqual(legacy.variants.familiesSnapshot(), []);
    assert.equal(variantFamiliesMatch(legacy.db, v12), true);
    assert.equal(legacy.photos.get('P1')?.derivativeKey, HASH, 'a schema-12 photo is the root variant of its asset');
    assert.equal(legacy.photos.get('P1')?.assetOwnerId, null);
  });
});
