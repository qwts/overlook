import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { activityBackupSnapshot } from '../activity/activity-publication.js';
import { boardsSnapshot } from '../db/board-repository.js';
import type { PhotosRepository } from '../db/photos-repository.js';
import type { BackupEngineDeps } from './backup-engine.js';

/** Library data beyond photos that every manifest generation must carry:
 * activity (schema 4+), boards (schema 5+), and the All Photos inclusion
 * rules (schema 7, #512). One place so `main/index.ts` stays a wiring file. */
export function libraryDataBackupDeps(
  db: BetterSqlite3.Database,
  repo: PhotosRepository,
): Pick<BackupEngineDeps, 'activitySnapshot' | 'boardsSnapshot' | 'galleryPolicySnapshot'> {
  return {
    activitySnapshot: () => activityBackupSnapshot(db),
    boardsSnapshot: () => boardsSnapshot(db),
    galleryPolicySnapshot: () => repo.galleryPolicy(),
  };
}
