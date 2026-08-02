import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

function photo(id: string, importedAt: string): PhotoInsert {
  return {
    id,
    fileName: `${id}.jpg`,
    fileKind: 'jpeg',
    width: 1,
    height: 1,
    bytes: 1,
    contentHash: (id === 'first' ? '1' : id === 'second' ? '2' : '3').repeat(64),
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
    importedAt,
    importSource: 'test',
    favorite: false,
    keyId: 1,
  };
}

test('exportable IDs cover every ordinary non-trashed photo in stable order (#885)', () => {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-export-scope-')), 'library.db'),
    dbKey: randomBytes(32),
  });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped', '2026-08-02T00:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  const first = photo('first', '2026-07-01T00:00:00.000Z');
  const second = photo('second', '2026-07-02T00:00:00.000Z');
  const trashed = photo('trashed', '2026-07-03T00:00:00.000Z');
  repo.insert(first);
  repo.insert(second);
  repo.insert(trashed);
  repo.softDelete([trashed.id]);

  assert.deepEqual(repo.exportableIds(), [first.id, second.id]);
  db.close();
});
