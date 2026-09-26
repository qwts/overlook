import { PHOTO_KEY_PRESENT_SQL } from './retained-photo-keys.js';
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll } from './sql.js';
import type { PhotoKeySelection } from '../../shared/ipc/library-selection-channels.js';

/** Read custody for the complete selection without loading photo metadata or paging the renderer. */
export function photoKeySelection(db: BetterSqlite3.Database, photoIds: readonly string[]): PhotoKeySelection {
  const ids = [...new Set(photoIds)];
  const rows = queryAll<{ id: string; keyPresent: number | null }>(
    db,
    `
    SELECT p.id, ${PHOTO_KEY_PRESENT_SQL} AS keyPresent
    FROM json_each(@ids) requested
    JOIN ordinary_visible_photos p ON p.id = requested.value
    LEFT JOIN keys k ON k.id = p.key_id
  `,
    { ids: JSON.stringify(ids) },
  );
  const custody = new Map(rows.map((row) => [row.id, row.keyPresent]));
  return {
    photoIds: ids.filter((id) => custody.has(id) && custody.get(id) !== 0),
    locked: rows.filter((row) => row.keyPresent === 0).length,
    missing: ids.length - rows.length,
  };
}
