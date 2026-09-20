import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

import { migrateProtectedVariantSources } from '../../src/main/db/protected-variant-migration.js';
import { queryAll } from '../../src/main/db/sql.js';

test('protected source migration backfills pending variants and leaves legacy defaults available', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE photos (id TEXT, asset_owner_id TEXT, derivative_key TEXT);
      CREATE TABLE protected_photo_migrations (migration_id TEXT, operation TEXT);
      CREATE TABLE protected_photo_migration_items (migration_id TEXT, photo_id TEXT);
      INSERT INTO photos VALUES ('root', NULL, 'root-key'), ('variant', 'root', 'variant-key');
      INSERT INTO protected_photo_migrations VALUES ('p', 'protect'), ('u', 'unprotect');
      INSERT INTO protected_photo_migration_items VALUES ('p', 'root'), ('p', 'variant'), ('p', 'gone'), ('u', 'variant');
    `);
    migrateProtectedVariantSources(db);
    assert.deepEqual(
      queryAll(
        db,
        `SELECT migration_id, photo_id, source_asset_owner_id, source_derivative_ref
      FROM protected_photo_migration_items ORDER BY migration_id, photo_id`,
      ),
      [
        { migration_id: 'p', photo_id: 'gone', source_asset_owner_id: null, source_derivative_ref: null },
        { migration_id: 'p', photo_id: 'root', source_asset_owner_id: 'root', source_derivative_ref: 'root-key' },
        { migration_id: 'p', photo_id: 'variant', source_asset_owner_id: 'root', source_derivative_ref: 'variant-key' },
        { migration_id: 'u', photo_id: 'variant', source_asset_owner_id: null, source_derivative_ref: null },
      ],
    );
  } finally {
    db.close();
  }
});
