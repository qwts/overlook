import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

// Provenance evidence (#495, ADR-0031 §5 + §8). One record per photo, bound
// to the subject hash and evaluator that produced it, stored as JSON exactly
// as written so a newer format is preserved and reported unsupported rather
// than rewritten. The row lives in the SQLCipher library with its subject's
// other metadata and cascades with the photo on purge (the death list, §8).
export function migratePhotoProvenance(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE photo_provenance (
      photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
      subject_hash TEXT NOT NULL,
      evaluator TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      tier TEXT NOT NULL,
      evidence TEXT NOT NULL CHECK (json_valid(evidence))
    );
  `);
}
