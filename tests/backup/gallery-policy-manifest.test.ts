import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  backupManifestV6Schema,
  buildBackupManifestV7,
  parseBackupManifest,
  type BackupManifestSnapshotV7,
} from '../../src/main/backup/backup-manifest.js';

// #512 / ADR-0030 §5: inclusion rules are library data, so the manifest
// carries them (schema 7) and older generations still parse without them.

const snapshot: BackupManifestSnapshotV7 = {
  databaseSchema: 27,
  keyIds: [],
  totals: { photos: 0, bytes: 0, albums: 0 },
  photos: [],
  albums: [],
  protectedAlbums: [],
  protectedPhotos: [],
  activity: [],
  boards: [],
  sidecars: [],
  galleryPolicy: { showUnavailable: false, minimumMegapixels: 2 },
};

describe('gallery policy in backup manifests (#512)', () => {
  test('schema 7 carries the policy and round-trips through the parser', () => {
    assert.equal(BACKUP_MANIFEST_SCHEMA_VERSION, 7);
    const manifest = buildBackupManifestV7({ libraryId: '01JZZZZZZZZZZZZZZZZZZZZZZZ', generatedAt: '2026-09-01T00:00:00.000Z', snapshot });
    assert.equal(manifest.schema, 7);
    assert.deepEqual(manifest.galleryPolicy, { showUnavailable: false, minimumMegapixels: 2 });
    const parsed = parseBackupManifest(JSON.parse(JSON.stringify(manifest)) as unknown);
    assert.equal(parsed.restorable, true);
    if (parsed.restorable && parsed.manifest.schema === 7) assert.deepEqual(parsed.manifest.galleryPolicy, manifest.galleryPolicy);
  });

  test('a schema-6 generation without a policy still parses, and a schema-7 one without it does not', () => {
    const { galleryPolicy: _policy, ...withoutPolicy } = snapshot;
    const v6 = backupManifestV6Schema.parse({
      schema: 6,
      libraryId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      generatedAt: '2026-09-01T00:00:00.000Z',
      ...withoutPolicy,
    });
    assert.equal(parseBackupManifest(v6).restorable, true);
    assert.throws(
      () => parseBackupManifest({ ...v6, schema: 7 }),
      /invalid schema-7 manifest/u,
      'the policy is not optional: a restore must not silently fall back to defaults',
    );
    assert.throws(
      () => parseBackupManifest({ ...v6, schema: 7, galleryPolicy: { showUnavailable: true, minimumMegapixels: 0 } }),
      /invalid schema-7/u,
    );
  });
});
