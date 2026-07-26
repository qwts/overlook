import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import { getLoadablePath } from 'sqlite-vec';

const SUPPORTED_TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);

export function vectorExtensionSupported(platform = process.platform, arch = process.arch): boolean {
  return SUPPORTED_TARGETS.has(`${platform}-${arch}`);
}

/** SQLite itself dlopens this path, outside Electron's asar-aware fs shim. */
export function vectorExtensionPath(loadablePath = getLoadablePath()): string {
  return loadablePath.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2');
}

/** Loads the exact-pinned sqlite-vec extension into one SQLCipher connection. */
export function loadVectorExtension(db: Pick<BetterSqlite3.Database, 'loadExtension'>): void {
  db.loadExtension(vectorExtensionPath());
}

/**
 * Keeps the portable relational migration independent of native availability.
 * Unsupported targets can still open and mutate a library; a later supported
 * target repairs dormant vec0 rows before restoring the cleanup trigger.
 */
export function configureEmbeddingVectorSchema(db: Pick<BetterSqlite3.Database, 'exec' | 'transaction'>, available: boolean): void {
  db.transaction(() => {
    if (!available) {
      db.exec('DROP TRIGGER IF EXISTS photo_embeddings_ad');
      return;
    }
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS photo_embedding_vectors USING vec0(
        embedding_id INTEGER PRIMARY KEY,
        embedding int8[512]
      );
      DELETE FROM photo_embedding_vectors
        WHERE embedding_id NOT IN (SELECT embedding_id FROM photo_embeddings);
      CREATE TRIGGER IF NOT EXISTS photo_embeddings_ad AFTER DELETE ON photo_embeddings BEGIN
        DELETE FROM photo_embedding_vectors
          WHERE embedding_id = old.embedding_id;
      END;
    `);
  })();
}
