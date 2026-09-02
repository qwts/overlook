import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { activityBackupSnapshot } from '../activity/activity-publication.js';
import { albumTreeSnapshot } from '../db/album-tree-repository.js';
import { boardsSnapshot } from '../db/board-repository.js';
import { EditRevisionRepository } from '../db/edit-revision-repository.js';
import type { PhotosRepository } from '../db/photos-repository.js';
import type { BackupEngineDeps } from './backup-engine.js';

/** Library data beyond photos that every manifest generation must carry:
 * activity (schema 4+), boards (schema 5+), the All Photos inclusion rules
 * (schema 7, #512), hidden albums (schema 8, #494), and the folder tree with
 * organizational tags (schema 9, #505), Smart Albums (schema 10, #514), and
 * edit revisions (schema 11, #493). One place so `main/index.ts` stays a
 * wiring file. */
export function libraryDataBackupDeps(
  db: BetterSqlite3.Database,
  repo: PhotosRepository,
): Pick<
  BackupEngineDeps,
  'activitySnapshot' | 'boardsSnapshot' | 'galleryPolicySnapshot' | 'hiddenAlbumIdsSnapshot' | 'albumTreeSnapshot' | 'editRevisionsSnapshot'
> {
  return {
    activitySnapshot: () => activityBackupSnapshot(db),
    boardsSnapshot: () => boardsSnapshot(db),
    galleryPolicySnapshot: () => repo.galleryPolicy(),
    hiddenAlbumIdsSnapshot: () => repo.hiddenAlbumIds(),
    albumTreeSnapshot: () => albumTreeSnapshot(db),
    editRevisionsSnapshot: (photoIds) => new EditRevisionRepository(db).snapshot(photoIds),
  };
}
