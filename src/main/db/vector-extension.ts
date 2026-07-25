import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import { getLoadablePath } from 'sqlite-vec';

/** SQLite itself dlopens this path, outside Electron's asar-aware fs shim. */
export function vectorExtensionPath(loadablePath = getLoadablePath()): string {
  return loadablePath.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2');
}

/** Loads the exact-pinned sqlite-vec extension into one SQLCipher connection. */
export function loadVectorExtension(db: Pick<BetterSqlite3.Database, 'loadExtension'>): void {
  db.loadExtension(vectorExtensionPath());
}
