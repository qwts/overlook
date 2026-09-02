import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

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

export function moveAlbum(db: BetterSqlite3.Database, albumId: string, position: number): AlbumOrderResult {
  return db.transaction(() => {
    const before = readAlbumOrder(db);
    const current = before.indexOf(albumId);
    if (current === -1) throw new Error(`album ${albumId} does not exist`);
    if (!Number.isInteger(position) || position < 0 || position >= before.length) throw new Error('album position is out of range');
    const after = [...before];
    after.splice(current, 1);
    after.splice(position, 0, albumId);
    return replaceAlbumOrder(db, after);
  })();
}
