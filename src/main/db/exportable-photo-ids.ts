import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll } from './sql.js';

/** Complete ordinary-library export scope (#885), independent of renderer paging. */
export function readExportablePhotoIds(db: BetterSqlite3.Database): readonly string[] {
  return queryAll<{ id: string }>(
    db,
    `SELECT id FROM ordinary_visible_photos
     WHERE deleted_at IS NULL
     ORDER BY imported_at ASC, id ASC`,
  ).map(({ id }) => id);
}
