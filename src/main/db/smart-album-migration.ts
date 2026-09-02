import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

// Smart Albums (#514, ADR-0030 §3) are collections of kind 'smart' whose
// only content is a versioned predicate document — never membership rows.
// The document is stored as JSON text exactly as written, so a reader that
// cannot evaluate it (a newer predicate version, an unknown facet) preserves
// it unchanged and fails closed instead of dropping clauses.
export function migrateSmartAlbums(db: BetterSqlite3.Database): void {
  db.exec(`
    ALTER TABLE albums ADD COLUMN predicate TEXT
      CHECK (predicate IS NULL OR json_valid(predicate));
  `);
}
