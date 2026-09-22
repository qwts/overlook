import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import { queryGet } from './sql.js';

/** Mutable, device-local publication debt; revision history remains immutable. */
export class EditBakeDebtRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  pending(photoId: string): string | undefined {
    return queryGet<{ head: string }>(this.db, 'SELECT head_revision_id AS head FROM photo_edit_bake_debt WHERE photo_id = ?', photoId)
      ?.head;
  }

  /** A stale completion cannot settle a newer revision's repair debt. */
  settle(photoId: string, headId: string): boolean {
    return (
      queryGet(
        this.db,
        `DELETE FROM photo_edit_bake_debt
      WHERE photo_id = ? AND head_revision_id = ?
        AND head_revision_id = (SELECT edit_head FROM photos WHERE id = ?)
      RETURNING photo_id`,
        photoId,
        headId,
        photoId,
      ) !== undefined
    );
  }
}
