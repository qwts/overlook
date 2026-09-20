import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { ActivityAppend } from '../../shared/activity/types.js';
import { albumTreeIssues } from '../../shared/library/album-tree.js';
import { depthFirstOrder, readAlbumTree, setAlbumTags } from './album-tree-repository.js';
import { run, runNamed } from './sql.js';

export interface OrdinaryAlbumRestoration {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly position: number;
  readonly showInAllPhotos?: boolean | undefined;
  readonly organization?:
    | {
        readonly parentId: string | null;
        readonly inheritsVisibility: boolean;
        readonly siblingPosition: number;
        readonly tags: readonly string[];
      }
    | undefined;
}

export interface AlbumRestorationPorts {
  readonly createId: () => string;
  /** Must append on the same database connection as the custody transaction. */
  readonly activity: { readonly append: (event: ActivityAppend) => unknown };
}

/** Called inside the photo-custody transaction: placement, tags and fallback
 * evidence must either commit with the restored photos or all roll back. */
export function restoreProtectedAlbum(
  db: BetterSqlite3.Database,
  album: OrdinaryAlbumRestoration,
  migrationId: string,
  now: string,
  ports: AlbumRestorationPorts,
): void {
  const tree = readAlbumTree(db);
  if (tree.some((row) => row.id === album.id)) throw new Error('ordinary album already exists');
  // Deleting the protected source can leave sparse global positions.
  const appendPosition = tree.reduce((maximum, row) => Math.max(maximum, row.position), -1) + 1;
  const organization = album.organization;
  const savedParent = organization?.parentId ?? null;
  const candidate = tree.find((row) => row.id === savedParent && row.kind === 'folder');
  const parent =
    candidate !== undefined &&
    albumTreeIssues([...tree, { id: album.id, kind: 'album', parentId: savedParent, position: appendPosition }]).length === 0
      ? candidate
      : undefined;
  const parentId = parent?.id ?? null;
  const fallback = savedParent !== null && parent === undefined;
  const inherits = parentId !== null && (organization?.inheritsVisibility ?? false);
  const show = inherits && parent !== undefined ? parent.showInAllPhotos : album.showInAllPhotos !== false;
  const siblings = tree.filter((row) => row.parentId === parentId);
  // Legacy metadata has only a global index; preserve its relative top-level
  // placement. New metadata stores the actual sibling slot independently.
  const slot = fallback
    ? siblings.length
    : (organization?.siblingPosition ?? siblings.filter((row) => row.position < album.position).length);
  runNamed(
    db,
    `INSERT INTO albums (id, name, created_at, position, parent_id, inherits_visibility, show_in_all_photos)
    VALUES (@id, @name, @createdAt, @position, @parentId, @inherits, @show)`,
    {
      id: album.id,
      name: album.name,
      createdAt: album.createdAt,
      position: appendPosition,
      parentId,
      inherits: inherits ? 1 : 0,
      show: show ? 1 : 0,
    },
  );
  const order = siblings.map((row) => row.id);
  order.splice(Math.min(slot, order.length), 0, album.id);
  for (const [position, id] of depthFirstOrder(readAlbumTree(db), { parentId, order }).entries()) {
    run(db, 'UPDATE albums SET position = ? WHERE id = ?', position, id);
  }
  setAlbumTags(db, album.id, organization?.tags ?? [], ports.createId);
  if (fallback) {
    ports.activity.append({
      eventId: ports.createId(),
      operationId: migrationId,
      eventType: 'album.moved',
      occurredAt: now,
      actorClass: 'system',
      entityIds: [album.id],
      outcome: 'partial',
      payload: { reason: 'protected-parent-unavailable' },
    });
  }
}
