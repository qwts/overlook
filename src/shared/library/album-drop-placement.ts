import type { CollectionKind } from './album-tree.js';

export interface DropCollection {
  readonly id: string;
  readonly parentId?: string | null | undefined;
  readonly kind?: CollectionKind | undefined;
}

export type AlbumDropZone = 'before' | 'inside' | 'after';

/** Resolve a pointer target into one atomic parent + sibling placement.
 * The tree is in display order. Main remains authoritative for depth/cycles. */
export function albumDropPlacement(
  albums: readonly DropCollection[],
  sourceId: string,
  targetId: string,
  zone: AlbumDropZone,
): { readonly parentId: string | null; readonly position: number } | null {
  const target = albums.find((album) => album.id === targetId);
  if (target === undefined || sourceId === targetId || !albums.some((album) => album.id === sourceId)) return null;
  if (zone === 'inside' && target.kind !== 'folder') return null;
  const parentId = zone === 'inside' ? target.id : (target.parentId ?? null);
  const siblings = albums.filter((album) => album.id !== sourceId && (album.parentId ?? null) === parentId);
  const position = zone === 'inside' ? siblings.length : siblings.findIndex((album) => album.id === targetId) + (zone === 'after' ? 1 : 0);
  return { parentId, position };
}
