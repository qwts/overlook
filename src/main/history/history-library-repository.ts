import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { markDirty } from '../backup/sync-ledger.js';
import { queryGet } from '../db/sql.js';

export class HistoryLibraryRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  setFavorite(photoId: string, favorite: boolean): boolean {
    return this.db.transaction(() => {
      const updated = queryGet<{ favorite: number }>(
        this.db,
        `UPDATE photos SET favorite = @favorite
          WHERE id = @photoId AND id IN (SELECT id FROM ordinary_visible_photos)
          RETURNING favorite`,
        { photoId, favorite: favorite ? 1 : 0 },
      );
      if (updated === undefined) throw new Error(`photo ${photoId} does not exist`);
      markDirty(this.db, photoId);
      return updated.favorite === 1;
    })();
  }

  setFavorites(changes: readonly { readonly photoId: string; readonly favorite: boolean }[]): readonly string[] {
    return this.db.transaction(() => {
      const changed: string[] = [];
      for (const { photoId, favorite } of changes) {
        const updated = queryGet<{ favorite: number }>(
          this.db,
          `UPDATE photos SET favorite = @favorite
            WHERE id = @photoId AND favorite != @favorite
              AND id IN (SELECT id FROM ordinary_visible_photos)
            RETURNING favorite`,
          { photoId, favorite: favorite ? 1 : 0 },
        );
        if (updated === undefined) {
          if (this.favoriteState(photoId) === undefined) throw new Error(`photo ${photoId} does not exist`);
          continue;
        }
        markDirty(this.db, photoId);
        changed.push(photoId);
      }
      return changed;
    })();
  }

  favoriteState(photoId: string): boolean | undefined {
    const row = queryGet<{ favorite: number }>(this.db, 'SELECT favorite FROM ordinary_visible_photos WHERE id = ?', photoId);
    return row === undefined ? undefined : row.favorite === 1;
  }

  albumMembership(albumId: string, photoIds: readonly string[]): ReadonlyMap<string, boolean> | undefined {
    if (queryGet(this.db, 'SELECT 1 AS one FROM albums WHERE id = ?', albumId) === undefined) return undefined;
    return new Map(
      photoIds.map((photoId) => [
        photoId,
        queryGet<{ one: number }>(this.db, 'SELECT 1 AS one FROM album_photos WHERE album_id = ? AND photo_id = ?', albumId, photoId) !==
          undefined,
      ]),
    );
  }

  trashState(photoIds: readonly string[]): ReadonlyMap<string, 'live' | 'trashed' | 'missing'> {
    return new Map(
      photoIds.map((photoId) => {
        const row = queryGet<{ deleted_at: string | null }>(
          this.db,
          'SELECT deleted_at FROM ordinary_visible_photos WHERE id = ?',
          photoId,
        );
        return [photoId, row === undefined ? 'missing' : row.deleted_at === null ? 'live' : 'trashed'] as const;
      }),
    );
  }
}
