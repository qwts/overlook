import { randomUUID } from 'node:crypto';

import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { albumTreeSnapshot, refreshInheritedVisibility, setAlbumTags, type AlbumTreeSnapshot } from '../db/album-tree-repository.js';
import { run, runNamed } from '../db/sql.js';
import type { RestorableBackupManifest } from './backup-manifest.js';

// Album folders and organizational tags are library data (ADR-0030 §5): a
// restored library has the same tree, the same folder policies, and the
// same tags as the backed-up one. The manifest validator already proved the
// tree (parents resolve to folders, no cycles, bounded depth, unique sibling
// positions); this only writes it. Albums were inserted by `restoreManifest`
// at their manifest positions, so folders slot into the same global order.

export function restoreAlbumFolders(db: BetterSqlite3.Database, manifest: RestorableBackupManifest): void {
  if (!('folders' in manifest)) return;
  db.transaction(() => {
    for (const folder of manifest.folders) {
      runNamed(
        db,
        `INSERT INTO albums (id, name, created_at, position, kind, parent_id, show_in_all_photos, inherits_visibility)
         VALUES (@id, @name, @createdAt, @position, 'folder', NULL, @show, 0)`,
        { id: folder.id, name: folder.name, createdAt: folder.createdAt, position: folder.position, show: folder.showInAllPhotos ? 1 : 0 },
      );
    }
    for (const folder of manifest.folders) {
      if (folder.parentId !== null) run(db, 'UPDATE albums SET parent_id = ? WHERE id = ?', folder.parentId, folder.id);
      if (folder.tags.length > 0) setAlbumTags(db, folder.id, folder.tags, randomUUID);
    }
    // Smart Albums (#514) slot in after their folders exist; the document is
    // stored exactly as carried, so an unsupported one restores unchanged.
    if ('smartAlbums' in manifest) {
      for (const smart of manifest.smartAlbums) {
        runNamed(
          db,
          `INSERT INTO albums (id, name, created_at, position, kind, parent_id, show_in_all_photos, inherits_visibility, predicate)
           VALUES (@id, @name, @createdAt, @position, 'smart', @parentId, 1, 0, @predicate)`,
          {
            id: smart.id,
            name: smart.name,
            createdAt: smart.createdAt,
            position: smart.position,
            parentId: smart.parentId,
            predicate: JSON.stringify(smart.predicate),
          },
        );
        if (smart.tags.length > 0) setAlbumTags(db, smart.id, smart.tags, randomUUID);
      }
    }
    for (const placement of manifest.albumTree) {
      runNamed(db, 'UPDATE albums SET parent_id = @parentId, inherits_visibility = @inherits WHERE id = @albumId', {
        albumId: placement.albumId,
        parentId: placement.parentId,
        inherits: placement.inheritsVisibility ? 1 : 0,
      });
      if (placement.tags.length > 0) setAlbumTags(db, placement.albumId, placement.tags, randomUUID);
    }
  })();
}

/** After the hidden-album policy is applied: a manifest whose inheriting
 * albums disagree with their folders is normalized top-down, never trusted. */
export function settleInheritedVisibility(db: BetterSqlite3.Database): void {
  refreshInheritedVisibility(db);
}

function expectedTree(manifest: RestorableBackupManifest): AlbumTreeSnapshot {
  const smartAlbums = 'smartAlbums' in manifest ? manifest.smartAlbums : [];
  if ('folders' in manifest) return { folders: manifest.folders, albumTree: manifest.albumTree, smartAlbums };
  return {
    folders: [],
    albumTree: manifest.albums.map((album) => ({ albumId: album.id, parentId: null, inheritsVisibility: false, tags: [] })),
    smartAlbums,
  };
}

export function albumFoldersMatch(db: BetterSqlite3.Database, manifest: RestorableBackupManifest): boolean {
  const normalize = (snapshot: AlbumTreeSnapshot): string =>
    JSON.stringify({
      folders: [...snapshot.folders].sort((left, right) => left.id.localeCompare(right.id)),
      albumTree: [...snapshot.albumTree].sort((left, right) => left.albumId.localeCompare(right.albumId)),
      smartAlbums: [...snapshot.smartAlbums].sort((left, right) => left.id.localeCompare(right.id)),
    });
  return normalize(albumTreeSnapshot(db)) === normalize(expectedTree(manifest));
}
