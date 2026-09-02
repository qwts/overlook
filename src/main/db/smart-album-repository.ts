import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { SmartPredicate } from '../../shared/library/smart-album.js';
import { createCollection, readAlbumTags, setAlbumTags } from './album-tree-repository.js';
import { queryGet, run } from './sql.js';

// Smart Album mutations (#514, ADR-0030 §3). A Smart Album is a collection
// row of kind 'smart' carrying a predicate document; editing, duplicating,
// renaming, and deleting one never touches a photo or a membership row.

export interface CreateSmartAlbumInput {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly predicate: SmartPredicate;
}

export function createSmartAlbum(db: BetterSqlite3.Database, input: CreateSmartAlbumInput): void {
  db.transaction(() => {
    createCollection(db, { id: input.id, name: input.name, kind: 'smart', parentId: input.parentId });
    run(db, 'UPDATE albums SET predicate = ? WHERE id = ?', JSON.stringify(input.predicate), input.id);
  })();
}

function requireSmart(
  db: BetterSqlite3.Database,
  albumId: string,
): { readonly parentId: string | null; readonly name: string; readonly predicate: string } {
  const row = queryGet<{ parentId: string | null; name: string; predicate: string | null }>(
    db,
    `SELECT parent_id AS parentId, name, predicate FROM albums WHERE id = ? AND kind = 'smart'`,
    albumId,
  );
  if (row === undefined) throw new Error(`smart album ${albumId} does not exist`);
  return { parentId: row.parentId, name: row.name, predicate: row.predicate ?? 'null' };
}

/** Replaces the saved query. The whole document is rewritten: a predicate is
 * never partially edited, so an unsupported document is either kept as-is
 * or replaced by one this app fully understands. */
export function setSmartAlbumPredicate(db: BetterSqlite3.Database, albumId: string, predicate: SmartPredicate): void {
  requireSmart(db, albumId);
  run(db, 'UPDATE albums SET predicate = ? WHERE id = ?', JSON.stringify(predicate), albumId);
}

/** A copy beside the original: same folder, same query (byte for byte, so
 * an unsupported document copies unchanged), same tags, last among siblings. */
export function duplicateSmartAlbum(db: BetterSqlite3.Database, albumId: string, newId: string, name: string, tagId: () => string): void {
  db.transaction(() => {
    const original = requireSmart(db, albumId);
    createCollection(db, { id: newId, name, kind: 'smart', parentId: original.parentId });
    run(db, 'UPDATE albums SET predicate = ? WHERE id = ?', original.predicate, newId);
    const tags = readAlbumTags(db).get(albumId) ?? [];
    if (tags.length > 0) setAlbumTags(db, newId, tags, tagId);
  })();
}
