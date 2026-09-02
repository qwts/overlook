import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

// Migration 37 — disclosure classes (#509, ADR-0032 §6). One encrypted row
// holds the library's versioned per-field policy; the overrides table holds
// collection- and photo-scope narrowing (and explicitly recorded widening).
// The defaults are frozen here as the migration wrote them — the shared
// policy module owns the live defaults, and a later change to those must
// ship as its own migration.
export function migrateDisclosurePolicy(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE disclosure_policy (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL CHECK (version >= 1),
      fields TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO disclosure_policy (id, version, fields, updated_at)
      VALUES (
        1,
        1,
        '{"title":"shared","description":"shared","tags":"shared","captureTime":"shared","camera":"shared","lens":"shared","provenance":"shared","location":"private","ratings":"private","faces":"private","comments":"shared"}',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
    CREATE TABLE disclosure_overrides (
      scope TEXT NOT NULL CHECK (scope IN ('collection', 'photo')),
      scope_id TEXT NOT NULL,
      field TEXT NOT NULL,
      class TEXT NOT NULL CHECK (class IN ('private', 'shared', 'public')),
      widened INTEGER NOT NULL DEFAULT 0 CHECK (widened IN (0, 1)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, scope_id, field)
    );
  `);
}
