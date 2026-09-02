import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { siblingReorderedOrder } from './album-tree-repository.js';
import { queryAll, runNamed } from './sql.js';

export interface AlbumOrderResult {
  readonly changed: boolean;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

export function readAlbumOrder(db: BetterSqlite3.Database): string[] {
  return queryAll<{ id: string }>(db, 'SELECT id FROM albums ORDER BY position, id').map(({ id }) => id);
}

export function replaceAlbumOrder(db: BetterSqlite3.Database, order: readonly string[]): AlbumOrderResult {
  return db.transaction(() => {
    const before = readAlbumOrder(db);
    if (order.length !== before.length || new Set(order).size !== order.length) {
      throw new Error('album order must contain every album exactly once');
    }
    const expected = new Set(before);
    if (!order.every((id) => expected.has(id))) throw new Error('album order changed before reorder completed');
    const after = [...order];
    const changed = before.some((id, index) => id !== after[index]);
    if (changed) {
      for (const [position, id] of after.entries()) {
        runNamed(db, 'UPDATE albums SET position = @position WHERE id = @id', { id, position });
      }
    }
    return { changed, before, after };
  })();
}

/** Moves an album to `position` among its siblings (#505: one ordering
 * mechanism, scoped to the parent). The history still records the full
 * depth-first order, so undo replays through `replaceAlbumOrder`. */
export function moveAlbum(
  db: BetterSqlite3.Database,
  albumId: string,
  position: number,
): AlbumOrderResult & { readonly position: number; readonly total: number } {
  return db.transaction(() => {
    const sibling = siblingReorderedOrder(db, albumId, position);
    return { ...replaceAlbumOrder(db, sibling.order), position: sibling.position, total: sibling.total };
  })();
}
