import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryGet } from './sql.js';

export interface FavoriteMutation {
  readonly id: string;
  readonly favorite: boolean;
}

export interface FavoriteMutationResult {
  readonly changed: readonly FavoriteMutation[];
  readonly missing: readonly string[];
}

export function toggleFavorites(
  db: BetterSqlite3.Database,
  photoIds: readonly string[],
  markDirty: (photoId: string) => void,
): FavoriteMutationResult {
  return db.transaction(() => {
    const changed: FavoriteMutation[] = [];
    const missing: string[] = [];
    for (const id of new Set(photoIds)) {
      const updated = queryGet<{ favorite: number }>(
        db,
        `UPDATE photos SET favorite = 1 - favorite
          WHERE id = ? AND id IN (SELECT id FROM ordinary_visible_photos)
          RETURNING favorite`,
        id,
      );
      if (updated === undefined) {
        missing.push(id);
        continue;
      }
      markDirty(id);
      changed.push({ id, favorite: updated.favorite === 1 });
    }
    return { changed, missing };
  })();
}

export function toggleFavorite(db: BetterSqlite3.Database, photoId: string, markDirty: (photoId: string) => void): boolean {
  const result = toggleFavorites(db, [photoId], markDirty);
  const changed = result.changed[0];
  if (changed === undefined) throw new Error(`photo ${photoId} does not exist`);
  return changed.favorite;
}
