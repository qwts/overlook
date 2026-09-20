import { randomUUID } from 'node:crypto';

import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { ActivityRepository } from '../activity/activity-repository.js';
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

/** Called inside the photo-custody transaction: placement, tags and fallback
 * evidence must either commit with the restored photos or all roll back. */
export function restoreProtectedAlbum(db: BetterSqlite3.Database, album: OrdinaryAlbumRestoration, migrationId: string, now: string): void {
  const tree = readAlbumTree(db);
  if (tree.some((row) => row.id === album.id)) throw new Error('ordinary album already exists');
  const organization = album.organization;
  const savedParent = organization?.parentId ?? null;
  const parent = tree.find((row) => row.id === savedParent && row.kind === 'folder');
  const parentId = parent?.id ?? null;
  const fallback = savedParent !== null && parent === undefined;
  const inherits = organization?.inheritsVisibility ?? false;
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
      position: tree.length,
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
  setAlbumTags(db, album.id, organization?.tags ?? [], randomUUID);
  if (fallback) {
    new ActivityRepository(db).append({
      eventId: randomUUID(),
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
