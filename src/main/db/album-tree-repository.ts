import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { MAX_ALBUM_DEPTH, albumDescendantIds, type CollectionKind } from '../../shared/library/album-tree.js';
import { markDirty } from '../backup/sync-ledger.js';
import { refreshAlbumMembersInAllPhotos, refreshInAllPhotos, writeAlbumVisibility } from './album-visibility-repository.js';
import { queryAll, queryGet, run, runNamed } from './sql.js';

// Album folders and organizational tags (#505, ADR-0030 §1/§2/§5).
// `position` is one global depth-first order: `ORDER BY position` walks the
// tree, and sibling order is the filtered global order, so the existing
// reorder history (before/after id lists) keeps working unchanged. Every
// structural write renormalizes positions and re-derives inherited
// visibility inside its own transaction.

export interface AlbumTreeRow {
  readonly id: string;
  readonly name: string;
  readonly kind: CollectionKind;
  readonly parentId: string | null;
  readonly position: number;
  readonly showInAllPhotos: boolean;
  readonly inheritsVisibility: boolean;
}

export function readAlbumTree(db: BetterSqlite3.Database): AlbumTreeRow[] {
  return queryAll<{
    id: string;
    name: string;
    kind: CollectionKind;
    parentId: string | null;
    position: number;
    show: number;
    inherits: number;
  }>(
    db,
    `SELECT id, name, kind, parent_id AS parentId, position, show_in_all_photos AS show, inherits_visibility AS inherits
       FROM albums ORDER BY position, id`,
  ).map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    parentId: row.parentId,
    position: row.position,
    showInAllPhotos: row.show === 1,
    inheritsVisibility: row.inherits === 1,
  }));
}

const byId = (rows: readonly AlbumTreeRow[]): Map<string, AlbumTreeRow> => new Map(rows.map((row) => [row.id, row]));

function childrenOf(rows: readonly AlbumTreeRow[]): Map<string | null, AlbumTreeRow[]> {
  const children = new Map<string | null, AlbumTreeRow[]>();
  for (const row of rows) {
    const list = children.get(row.parentId) ?? [];
    list.push(row);
    children.set(row.parentId, list);
  }
  return children;
}

/** Depth of `id` (roots are 0); `null` is the virtual root at -1. */
function depthOf(rows: Map<string, AlbumTreeRow>, id: string | null): number {
  let depth = -1;
  let cursor = id;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (seen.has(cursor)) throw new Error('album tree contains a cycle');
    seen.add(cursor);
    const row = rows.get(cursor);
    if (row === undefined) throw new Error(`album ${cursor} does not exist`);
    depth += 1;
    cursor = row.parentId;
  }
  return depth;
}

function subtreeHeight(children: Map<string | null, AlbumTreeRow[]>, id: string): number {
  const kids = children.get(id) ?? [];
  return kids.length === 0 ? 0 : 1 + Math.max(...kids.map((kid) => subtreeHeight(children, kid.id)));
}

function requireFolder(rows: Map<string, AlbumTreeRow>, parentId: string | null): void {
  if (parentId === null) return;
  const parent = rows.get(parentId);
  if (parent === undefined) throw new Error(`folder ${parentId} does not exist`);
  if (parent.kind !== 'folder') throw new Error(`${parentId} is not a folder`);
}

function requireDepth(depth: number): void {
  if (depth > MAX_ALBUM_DEPTH) throw new Error(`albums nest at most ${String(MAX_ALBUM_DEPTH)} levels deep`);
}

/** Depth-first order: children after their parent, siblings by position.
 * `override` replaces one parent's sibling order (a reorder in flight). */
export function depthFirstOrder(rows: readonly AlbumTreeRow[], override?: { parentId: string | null; order: readonly string[] }): string[] {
  const children = childrenOf(rows);
  if (override !== undefined) {
    const lookup = byId(rows);
    children.set(
      override.parentId,
      override.order.flatMap((id) => {
        const row = lookup.get(id);
        return row === undefined ? [] : [row];
      }),
    );
  }
  const out: string[] = [];
  const visit = (parentId: string | null): void => {
    for (const child of children.get(parentId) ?? []) {
      out.push(child.id);
      visit(child.id);
    }
  };
  visit(null);
  return out;
}

export function normalizeAlbumPositions(db: BetterSqlite3.Database): void {
  for (const [position, id] of depthFirstOrder(readAlbumTree(db)).entries()) {
    runNamed(db, 'UPDATE albums SET position = @position WHERE id = @id AND position != @position', { id, position });
  }
}

/** Sibling order for a reorder of `albumId` to `position` among its
 * siblings, expressed as the full depth-first order the history needs. */
export function siblingReorderedOrder(
  db: BetterSqlite3.Database,
  albumId: string,
  position: number,
): { readonly order: string[]; readonly position: number; readonly total: number } {
  const tree = readAlbumTree(db);
  const node = byId(tree).get(albumId);
  if (node === undefined) throw new Error(`album ${albumId} does not exist`);
  const siblings = tree.filter((row) => row.parentId === node.parentId).map((row) => row.id);
  if (!Number.isInteger(position) || position < 0 || position >= siblings.length) throw new Error('album position is out of range');
  const next = siblings.filter((id) => id !== albumId);
  next.splice(position, 0, albumId);
  return { order: depthFirstOrder(tree, { parentId: node.parentId, order: next }), position, total: siblings.length };
}

/** Member photo ids of the given albums with their current All Photos flag. */
function memberFlags(db: BetterSqlite3.Database, albumIds: Iterable<string>): Map<string, number> {
  const flags = new Map<string, number>();
  for (const albumId of albumIds) {
    for (const row of queryAll<{ id: string; flag: number }>(
      db,
      'SELECT p.id, p.in_all_photos AS flag FROM photos p WHERE p.id IN (SELECT photo_id FROM album_photos WHERE album_id = @albumId)',
      { albumId },
    )) {
      flags.set(row.id, row.flag);
    }
  }
  return flags;
}

/** Re-derives the materialized policy of every inheriting collection from
 * its folder, top-down, and refreshes the flags of the members of every
 * album whose policy changed. Returns the photos that changed sides. */
export function refreshInheritedVisibility(db: BetterSqlite3.Database): string[] {
  return db.transaction(() => {
    const tree = readAlbumTree(db);
    const children = childrenOf(tree);
    const changedAlbums: string[] = [];
    const visit = (parentId: string | null, parentShow: boolean | null): void => {
      for (const child of children.get(parentId) ?? []) {
        const effective = child.inheritsVisibility && parentShow !== null ? parentShow : child.showInAllPhotos;
        if (effective !== child.showInAllPhotos) {
          runNamed(db, 'UPDATE albums SET show_in_all_photos = @show WHERE id = @id', { id: child.id, show: effective ? 1 : 0 });
          changedAlbums.push(child.id);
        }
        visit(child.id, effective);
      }
    };
    visit(null, null);
    const before = memberFlags(db, changedAlbums);
    for (const albumId of changedAlbums) refreshAlbumMembersInAllPhotos(db, albumId);
    const after = memberFlags(db, changedAlbums);
    return [...before].filter(([id, flag]) => after.get(id) !== flag).map(([id]) => id);
  })();
}

export interface CreateCollectionInput {
  readonly id: string;
  readonly name: string;
  readonly kind: CollectionKind;
  readonly parentId: string | null;
}

/** Creates an album or folder as the last child of `parentId`. A child of a
 * folder starts out following the folder's policy (§2: the folder setting is
 * the default for descendants that have not set their own). */
export function createCollection(db: BetterSqlite3.Database, input: CreateCollectionInput): void {
  db.transaction(() => {
    const rows = byId(readAlbumTree(db));
    requireFolder(rows, input.parentId);
    requireDepth(depthOf(rows, input.parentId) + 1);
    const parent = input.parentId === null ? undefined : rows.get(input.parentId);
    runNamed(
      db,
      `INSERT INTO albums (id, name, created_at, position, kind, parent_id, show_in_all_photos, inherits_visibility)
       VALUES (@id, @name, @createdAt, (SELECT COALESCE(max(position) + 1, 0) FROM albums), @kind, @parentId, @show, @inherits)`,
      {
        id: input.id,
        name: input.name,
        createdAt: new Date().toISOString(),
        kind: input.kind,
        parentId: input.parentId,
        show: parent === undefined || parent.showInAllPhotos ? 1 : 0,
        inherits: parent === undefined ? 0 : 1,
      },
    );
    if (parent !== undefined) normalizeAlbumPositions(db);
  })();
}

/** Moves a collection under `parentId` (null = top level) as its last
 * child. Cycles and the depth bound are rejected here, inside the write. A
 * visible album entering a folder adopts the folder's policy; an explicitly
 * hidden one keeps its own. Returns the photos that changed sides. */
export function moveCollection(db: BetterSqlite3.Database, albumId: string, parentId: string | null): string[] {
  return db.transaction(() => {
    const tree = readAlbumTree(db);
    const rows = byId(tree);
    const node = rows.get(albumId);
    if (node === undefined) throw new Error(`album ${albumId} does not exist`);
    requireFolder(rows, parentId);
    if (parentId !== null) {
      if (parentId === albumId || albumDescendantIds(tree, albumId).includes(parentId))
        throw new Error('a folder cannot be moved into itself');
      requireDepth(depthOf(rows, parentId) + 1 + subtreeHeight(childrenOf(tree), albumId));
    }
    if (node.parentId === parentId) return [];
    runNamed(
      db,
      `UPDATE albums SET parent_id = @parentId, inherits_visibility = @inherits,
              position = (SELECT max(position) + 1 FROM albums)
        WHERE id = @albumId`,
      { albumId, parentId, inherits: parentId !== null && node.showInAllPhotos ? 1 : 0 },
    );
    normalizeAlbumPositions(db);
    return refreshInheritedVisibility(db);
  })();
}

/** Sets one collection's policy: an explicit show/hide, or `'inherit'` to
 * follow its folder. Returns the photos that changed sides, including those
 * of descendants that inherit from a folder whose policy changed. */
export function setCollectionVisibility(db: BetterSqlite3.Database, albumId: string, mode: boolean | 'inherit'): string[] {
  return db.transaction(() => {
    const node = byId(readAlbumTree(db)).get(albumId);
    if (node === undefined) throw new Error(`album ${albumId} does not exist`);
    if (mode === 'inherit') {
      if (node.parentId === null) throw new Error(`album ${albumId} has no folder to inherit from`);
      run(db, 'UPDATE albums SET inherits_visibility = 1 WHERE id = ?', albumId);
      return refreshInheritedVisibility(db);
    }
    run(db, 'UPDATE albums SET inherits_visibility = 0 WHERE id = ?', albumId);
    const own = writeAlbumVisibility(db, albumId, mode);
    return [...new Set([...own, ...refreshInheritedVisibility(db)])];
  })();
}

export type FolderDeletion = { readonly mode: 'move'; readonly destinationId: string | null } | { readonly mode: 'recursive' };

export interface FolderDeletionResult {
  /** Photos to re-manifest: former members of removed albums plus any that changed sides. */
  readonly members: string[];
  readonly removedIds: string[];
  readonly folders: number;
  readonly albums: number;
}

/** ADR-0023 Tier M ceremony: a non-empty folder either hands its children
 * to a destination or removes its structure recursively. Photos are never
 * deleted; membership rows cascade with their albums. */
export function deleteFolder(db: BetterSqlite3.Database, folderId: string, deletion: FolderDeletion): FolderDeletionResult {
  return db.transaction(() => {
    const tree = readAlbumTree(db);
    const rows = byId(tree);
    const folder = rows.get(folderId);
    if (folder === undefined || folder.kind !== 'folder') throw new Error(`folder ${folderId} does not exist`);
    const children = childrenOf(tree);
    const descendants = albumDescendantIds(tree, folderId);
    const members = new Set<string>();
    const removedIds: string[] = [];
    let folders = 1;
    let albums = 0;
    if (deletion.mode === 'move') {
      const destinationId = deletion.destinationId;
      requireFolder(rows, destinationId);
      if (destinationId === folderId || (destinationId !== null && descendants.includes(destinationId))) {
        throw new Error('children cannot move into the folder being deleted');
      }
      if (destinationId !== null) {
        const depth = depthOf(rows, destinationId);
        for (const child of children.get(folderId) ?? []) requireDepth(depth + 1 + subtreeHeight(children, child.id));
      }
      runNamed(
        db,
        `UPDATE albums SET parent_id = @destinationId,
                inherits_visibility = CASE WHEN @destinationId IS NULL THEN 0 ELSE inherits_visibility END
          WHERE parent_id = @folderId`,
        { destinationId, folderId },
      );
    } else {
      for (const id of [...descendants].reverse()) {
        const row = rows.get(id);
        if (row === undefined) continue;
        if (row.kind === 'album') {
          albums += 1;
          for (const { photoId } of queryAll<{ photoId: string }>(
            db,
            `SELECT ap.photo_id AS photoId FROM album_photos ap
               JOIN ordinary_visible_photos p ON p.id = ap.photo_id WHERE ap.album_id = @albumId`,
            { albumId: id },
          )) {
            members.add(photoId);
          }
        } else {
          folders += 1;
        }
        run(db, 'DELETE FROM albums WHERE id = ?', id);
        removedIds.push(id);
      }
    }
    run(db, 'DELETE FROM albums WHERE id = ?', folderId);
    removedIds.push(folderId);
    for (const photoId of members) markDirty(db, photoId);
    refreshInAllPhotos(db, members);
    normalizeAlbumPositions(db);
    const changed = refreshInheritedVisibility(db);
    return { members: [...new Set([...members, ...changed])], removedIds, folders, albums };
  })();
}

/** Organizational tags: trimmed, de-duplicated case-insensitively (first
 * spelling wins), in the order given. */
export function normalizeTagNames(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of tags) {
    const name = raw.trim().replace(/\s+/gu, ' ');
    const key = name.toLowerCase();
    if (name === '' || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function readAlbumTags(db: BetterSqlite3.Database): Map<string, string[]> {
  const tags = new Map<string, string[]>();
  for (const row of queryAll<{ albumId: string; name: string }>(
    db,
    `SELECT l.album_id AS albumId, t.name FROM album_tag_links l JOIN album_tags t ON t.id = l.tag_id ORDER BY t.name COLLATE NOCASE`,
  )) {
    const list = tags.get(row.albumId) ?? [];
    list.push(row.name);
    tags.set(row.albumId, list);
  }
  return tags;
}

/** Replaces one collection's tag set; vocabulary rows nothing references
 * any more are dropped so the tag list only ever offers live tags. */
export function setAlbumTags(db: BetterSqlite3.Database, albumId: string, tags: readonly string[], newId: () => string): string[] {
  return db.transaction(() => {
    if (queryGet<{ one: number }>(db, 'SELECT 1 AS one FROM albums WHERE id = ?', albumId) === undefined) {
      throw new Error(`album ${albumId} does not exist`);
    }
    const names = normalizeTagNames(tags);
    run(db, 'DELETE FROM album_tag_links WHERE album_id = ?', albumId);
    for (const name of names) {
      const existing = queryGet<{ id: string }>(db, 'SELECT id FROM album_tags WHERE name = ?', name);
      const tagId = existing?.id ?? newId();
      if (existing === undefined) {
        runNamed(db, 'INSERT INTO album_tags (id, name, created_at) VALUES (@id, @name, @createdAt)', {
          id: tagId,
          name,
          createdAt: new Date().toISOString(),
        });
      }
      run(db, 'INSERT INTO album_tag_links (album_id, tag_id) VALUES (?, ?)', albumId, tagId);
    }
    run(db, 'DELETE FROM album_tags WHERE id NOT IN (SELECT tag_id FROM album_tag_links)');
    return names;
  })();
}

export interface AlbumFolderSnapshot {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly position: number;
  readonly parentId: string | null;
  readonly showInAllPhotos: boolean;
  readonly tags: readonly string[];
}

export interface AlbumPlacementSnapshot {
  readonly albumId: string;
  readonly parentId: string | null;
  readonly inheritsVisibility: boolean;
  readonly tags: readonly string[];
}

export interface AlbumTreeSnapshot {
  readonly folders: readonly AlbumFolderSnapshot[];
  readonly albumTree: readonly AlbumPlacementSnapshot[];
}

/** The structure a backup manifest carries (ADR-0030 §5): folders with their
 * policy, and every album's placement, in position order. */
export function albumTreeSnapshot(db: BetterSqlite3.Database): AlbumTreeSnapshot {
  const tags = readAlbumTags(db);
  const createdAt = new Map(
    queryAll<{ id: string; createdAt: string }>(db, 'SELECT id, created_at AS createdAt FROM albums').map((r) => [r.id, r.createdAt]),
  );
  const tree = readAlbumTree(db);
  return {
    folders: tree
      .filter((row) => row.kind === 'folder')
      .map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: createdAt.get(row.id) ?? '',
        position: row.position,
        parentId: row.parentId,
        showInAllPhotos: row.showInAllPhotos,
        tags: tags.get(row.id) ?? [],
      })),
    albumTree: tree
      .filter((row) => row.kind === 'album')
      .map((row) => ({
        albumId: row.id,
        parentId: row.parentId,
        inheritsVisibility: row.inheritsVisibility,
        tags: tags.get(row.id) ?? [],
      })),
  };
}
