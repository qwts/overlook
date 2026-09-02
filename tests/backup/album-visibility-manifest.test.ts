import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  buildBackupManifestV7,
  buildBackupManifestV8,
  parseBackupManifest,
  type BackupManifestSnapshotV8,
} from '../../src/main/backup/backup-manifest.js';
import { albumVisibilityMatches, restoreAlbumVisibility } from '../../src/main/backup/restore-album-visibility.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { queryAll, run } from '../../src/main/db/sql.js';

// #494 / ADR-0030 §5 + §7: the hidden-album policy is library data in the
// manifest (schema 8); the per-photo flag is never carried — restore rebuilds
// it from the restored rows.

const album = (id: string, position: number) => ({ id, name: id, createdAt: '2026-07-01T00:00:00.000Z', position, photoIds: [] });

const snapshot: BackupManifestSnapshotV8 = {
  databaseSchema: 28,
  keyIds: [],
  totals: { photos: 0, bytes: 0, albums: 2 },
  photos: [],
  albums: [album('hikes', 0), album('family', 1)],
  protectedAlbums: [],
  protectedPhotos: [],
  activity: [],
  boards: [],
  sidecars: [],
  galleryPolicy: { showUnavailable: true, minimumMegapixels: null },
  hiddenAlbumIds: ['hikes'],
};

describe('album visibility in backup manifests (#494)', () => {
  test('schema 8 carries the hidden albums and round-trips through the parser', () => {
    assert.equal(BACKUP_MANIFEST_SCHEMA_VERSION, 11);
    const manifest = buildBackupManifestV8({ libraryId: '01JZZZZZZZZZZZZZZZZZZZZZZZ', generatedAt: '2026-09-01T00:00:00.000Z', snapshot });
    assert.equal(manifest.schema, 8);
    assert.deepEqual(manifest.hiddenAlbumIds, ['hikes']);
    const parsed = parseBackupManifest(JSON.parse(JSON.stringify(manifest)) as unknown);
    assert.equal(parsed.restorable, true);
    if (parsed.restorable && parsed.manifest.schema === 8) assert.deepEqual(parsed.manifest.hiddenAlbumIds, ['hikes']);
  });

  test('hidden albums must exist and be unique; schema 7 still parses without them', () => {
    const { hiddenAlbumIds: _hidden, ...withoutVisibility } = snapshot;
    const v7 = buildBackupManifestV7({
      libraryId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      generatedAt: '2026-09-01T00:00:00.000Z',
      snapshot: withoutVisibility,
    });
    assert.equal(parseBackupManifest(v7).restorable, true);
    assert.throws(() => parseBackupManifest({ ...v7, schema: 8 }), /invalid schema-8 manifest/u, 'the policy list is not optional');
    assert.throws(() => parseBackupManifest({ ...v7, schema: 8, hiddenAlbumIds: ['ghost'] }), /hidden album is not in albums/u);
    assert.throws(() => parseBackupManifest({ ...v7, schema: 8, hiddenAlbumIds: ['hikes', 'hikes'] }), /duplicate hidden album/u);
  });

  test('restore writes the policy and rebuilds the flag from rows instead of trusting one', () => {
    const db = openLibraryDatabase({
      path: join(mkdtempSync(join(tmpdir(), 'overlook-vis-restore-')), 'library.db'),
      dbKey: randomBytes(32),
    });
    run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-01-01T00:00:00.000Z')`);
    for (const id of ['hikes', 'family']) {
      run(
        db,
        `INSERT INTO albums (id, name, created_at, position) VALUES (?, ?, '2026-07-01T00:00:00.000Z', ?)`,
        id,
        id,
        id === 'hikes' ? 0 : 1,
      );
    }
    run(
      db,
      `INSERT INTO photos (id, file_name, file_kind, width, height, bytes, content_hash, imported_at, import_source, key_id, in_all_photos)
       VALUES ('P1', 'a.jpg', 'jpeg', 10, 10, 1, 'h1', '2026-06-01T00:00:00.000Z', 'test', 1, 1)`,
    );
    run(db, `INSERT INTO sync_ledger (photo_id, status, dirty) VALUES ('P1', 'local', 1)`);
    run(db, `INSERT INTO album_photos (album_id, photo_id, position) VALUES ('hikes', 'P1', 0)`);
    const manifest = buildBackupManifestV8({ libraryId: '01JZZZZZZZZZZZZZZZZZZZZZZZ', generatedAt: '2026-09-01T00:00:00.000Z', snapshot });
    restoreAlbumVisibility(db, manifest);
    assert.deepEqual(
      queryAll<{ id: string; show: number }>(db, 'SELECT id, show_in_all_photos AS show FROM albums ORDER BY position').map((r) => [
        r.id,
        r.show,
      ]),
      [
        ['hikes', 0],
        ['family', 1],
      ],
    );
    assert.deepEqual(queryAll<{ flag: number }>(db, `SELECT in_all_photos AS flag FROM photos WHERE id = 'P1'`), [{ flag: 0 }]);
    assert.equal(albumVisibilityMatches(db, manifest), true);
    run(db, `UPDATE albums SET show_in_all_photos = 1 WHERE id = 'hikes'`);
    assert.equal(albumVisibilityMatches(db, manifest), false, 'a restored policy that drifted fails the verification');
    db.close();
  });
});
