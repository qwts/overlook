import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import type Database from 'better-sqlite3-multiple-ciphers';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { MIGRATIONS } from '../../src/main/db/migrations.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { ProvenanceRepository } from '../../src/main/db/provenance-repository.js';
import { queryGet, run } from '../../src/main/db/sql.js';
import { buildProvenanceEvidence } from '../../src/shared/library/provenance.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #495 / ADR-0031 §5 + §8: one evidence record per photo, replaced on
// re-evaluation, stored as written (a newer format is preserved and reported
// unsupported), and purged with its photo.

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

function open(): { db: Database.Database; photos: PhotosRepository; provenance: ProvenanceRepository } {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-provenance-')), 'library.db'),
    dbKey: Buffer.alloc(32, 7),
  });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-14T20:00:00.000Z')`);
  const photos = new PhotosRepository(db);
  photos.insert(photo('P1'));
  photos.insert(photo('P2'));
  return { db, photos, provenance: new ProvenanceRepository(db) };
}

const AT = '2026-09-02T10:00:00.000Z';

describe('provenance repository (#495)', () => {
  test('migration 32 creates the table (33 rebuilt photos after it); a photo starts with no record', () => {
    const { db, provenance } = open();
    assert.equal(MIGRATIONS.at(-1)?.version, 37);
    assert.ok(queryGet(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'photo_provenance'`));
    assert.equal(provenance.get('P1'), null);
  });

  test('put stores the record as written and a second put replaces it', () => {
    const { provenance } = open();
    const first = buildProvenanceEvidence({ subjectHash: 'a'.repeat(64), evaluatedAt: AT, sources: [] });
    provenance.put('P1', first);
    assert.deepEqual(provenance.get('P1')?.evidence, first);
    assert.equal(provenance.get('P1')?.tier, 'unknown');
    const second = buildProvenanceEvidence({
      subjectHash: 'a'.repeat(64),
      evaluatedAt: '2026-09-02T11:00:00.000Z',
      sources: [{ kind: 'declaration', origin: 'exif', field: 'Software', value: 'Midjourney', claim: 'generated' }],
    });
    provenance.put('P1', second);
    const stored = provenance.get('P1');
    assert.deepEqual(stored?.evidence, second);
    assert.equal(stored?.tier, 'declared');
    assert.equal(provenance.snapshot(new Set(['P1', 'P2'])).length, 1);
  });

  test('a newer record format is preserved and reported unsupported, never rewritten', () => {
    const { provenance } = open();
    const foreign = { version: 2, subjectHash: 'a'.repeat(64), evaluator: 'future/9', evaluatedAt: AT, tier: 'verified', extra: { x: 1 } };
    provenance.restore([
      {
        photoId: 'P1',
        subjectHash: foreign.subjectHash,
        evaluator: foreign.evaluator,
        evaluatedAt: AT,
        tier: 'verified',
        document: foreign,
      },
    ]);
    const stored = provenance.get('P1');
    assert.equal(stored?.evidence, null);
    assert.match(stored?.unsupported ?? '', /newer/u);
    assert.deepEqual(stored?.document, foreign);
    assert.deepEqual(provenance.snapshot(new Set(['P1']))[0]?.document, foreign);
  });

  test('deleting the photo purges its record (the death list, §8)', () => {
    const { db, provenance } = open();
    provenance.put('P2', buildProvenanceEvidence({ subjectHash: 'b'.repeat(64), evaluatedAt: AT, sources: [] }));
    run(db, 'DELETE FROM photos WHERE id = ?', 'P2');
    assert.equal(provenance.get('P2'), null);
  });
});
