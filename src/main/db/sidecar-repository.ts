import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll, queryGet, runNamed } from './sql.js';
import type { SidecarRole } from '../../shared/library/sidecar-files.js';

// Encrypted sidecar custody rows (#484, ADR-0031 §4): one row per companion
// file owned by a photo. Custody is PER PHOTO — blobs live under
// sidecars/<photoId>/ with the association authenticated in the envelope AAD
// — so rows CASCADE with the photo row and the purge service deletes the
// photo's sidecar directory without a shared-hash guard. Sibling of
// PhotosRepository (which sits at its file-size budget).

export interface SidecarRecord {
  readonly photoId: string;
  readonly role: SidecarRole;
  readonly fileName: string;
  readonly contentHash: string;
  readonly bytes: number;
  readonly keyId: number;
  readonly importedAt: string;
}

const COLUMNS = `photo_id AS photoId, role, file_name AS fileName, content_hash AS contentHash, bytes, key_id AS keyId, imported_at AS importedAt`;

export class SidecarRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  /** Idempotent per (photo, content): a re-imported or case-variant duplicate
   * companion with identical bytes collapses to one row. */
  insert(record: SidecarRecord): void {
    runNamed(
      this.db,
      `INSERT OR IGNORE INTO photo_sidecars (photo_id, role, file_name, content_hash, bytes, key_id, imported_at)
       VALUES (@photoId, @role, @fileName, @contentHash, @bytes, @keyId, @importedAt)`,
      {
        photoId: record.photoId,
        role: record.role,
        fileName: record.fileName,
        contentHash: record.contentHash,
        bytes: record.bytes,
        keyId: record.keyId,
        importedAt: record.importedAt,
      },
    );
  }

  listForPhoto(photoId: string): readonly SidecarRecord[] {
    return queryAll<SidecarRecord>(this.db, `SELECT ${COLUMNS} FROM photo_sidecars WHERE photo_id = @photoId ORDER BY file_name`, {
      photoId,
    });
  }

  /** Every custody row — the backup manifest and consistency scan source. */
  allRows(): readonly SidecarRecord[] {
    return queryAll<SidecarRecord>(this.db, `SELECT ${COLUMNS} FROM photo_sidecars ORDER BY photo_id, file_name`);
  }

  /** True when any row (any photo, live or soft-deleted) exists for the
   * photo — the consistency scan's ownership signal. */
  hasRowsForPhoto(photoId: string): boolean {
    return (queryGet<{ n: number }>(this.db, `SELECT COUNT(*) AS n FROM photo_sidecars WHERE photo_id = ?`, photoId)?.n ?? 0) > 0;
  }
}
