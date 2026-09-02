import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { queryAll } from '../../src/main/db/sql.js';

test('album order is atomic, complete, and contiguous (#225)', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'overlook-album-order-')), 'library.db');
  const db = openLibraryDatabase({ path, dbKey: randomBytes(32) });
  const repo = new PhotosRepository(db);
  repo.createAlbum('ALB1', 'One');
  repo.createAlbum('ALB2', 'Two');
  repo.createAlbum('ALB3', 'Three');
  assert.deepEqual(repo.reorderAlbum('ALB3', 0), {
    changed: true,
    before: ['ALB1', 'ALB2', 'ALB3'],
    after: ['ALB3', 'ALB1', 'ALB2'],
    position: 0,
    total: 3,
  });
  assert.deepEqual(queryAll(db, 'SELECT id, position FROM albums ORDER BY position'), [
    { id: 'ALB3', position: 0 },
    { id: 'ALB1', position: 1 },
    { id: 'ALB2', position: 2 },
  ]);
  assert.throws(() => repo.setAlbumOrder(['ALB1', 'ALB2']), /every album exactly once/u);
  assert.throws(() => repo.setAlbumOrder(['ALB1', 'ALB1', 'ALB3']), /every album exactly once/u);
  assert.deepEqual(repo.albumOrder(), ['ALB3', 'ALB1', 'ALB2'], 'invalid replacements roll back');
  db.close();
});
