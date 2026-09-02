import { createHash } from 'node:crypto';

import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { toRecord, type PhotoRow } from './photos-repository.js';
import { queryAll, queryGet, run, runNamed } from './sql.js';
import type { PhotoRecord } from '../../shared/library/types.js';

// Variant families (#496, ADR-0031 §1 + §3). Every photos row is a variant
// of the original asset its content hash names; Duplicate adds a sibling
// row over the same hash and key, with its own identity, metadata, edit
// head, derivatives, and album seats. The database is the source of truth
// for original ownership: a family is simply every row on the hash, and
// custody may only go when none is left (purge-service, §8).

const DERIVATIVE_KEY_DOMAIN = 'overlook-variant/1';

/** The address a duplicate's derivatives live under: distinct from the
 * original's legacy key (its content hash) and from every sibling's. */
export function variantDerivativeKey(photoId: string, contentHash: string): string {
  return createHash('sha256').update(`${DERIVATIVE_KEY_DOMAIN}\n${photoId}\n${contentHash}`).digest('hex');
}

export interface VariantFamily {
  readonly contentHash: string;
  /** The Promoted representative, or null when no one was chosen (§3). */
  readonly representativeId: string | null;
  /** Live variants on the hash, oldest first. */
  readonly variants: readonly PhotoRecord[];
}

/** A Promoted representative; families without one are not recorded (#496). */
export interface VariantFamilyRow {
  readonly contentHash: string;
  readonly representativeId: string;
}

// Columns Duplicate does NOT copy from the source row: identity, lineage,
// the derivative address, the Original marker (§3), favorite, trash state,
// the edit head (the variant gets its own root revision), and import time.
// The asset owner — the id the original's envelope is bound to — carries
// over (the source's owner, or the source itself when it is the root).
const OVERRIDDEN_COLUMNS: Readonly<Record<string, string>> = {
  id: '@id',
  imported_at: '@now',
  favorite: '0',
  is_original: '0',
  deleted_at: 'NULL',
  edit_head: 'NULL',
  derivative_key: '@derivativeKey',
  variant_source_id: '@sourceId',
  asset_owner_id: 'coalesce("asset_owner_id", "id")',
};

export class VariantRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  family(contentHash: string): VariantFamily {
    const rows = queryAll<PhotoRow>(
      this.db,
      `SELECT p.*, l.status AS sync_state, l.coverage AS coverage, k.material_present AS key_present, p.imported_at AS sort_key
         FROM ordinary_visible_photos p LEFT JOIN sync_ledger l ON l.photo_id = p.id LEFT JOIN keys k ON k.id = p.key_id
        WHERE p.content_hash = @contentHash AND p.deleted_at IS NULL
        ORDER BY p.imported_at, p.id`,
      { contentHash },
    );
    return { contentHash, representativeId: this.representative(contentHash), variants: rows.map(toRecord) };
  }

  /** Live rows on the hash — the count the Inspector shows. */
  liveCount(contentHash: string): number {
    return (
      queryGet<{ n: number }>(this.db, `SELECT count(*) AS n FROM photos WHERE content_hash = ? AND deleted_at IS NULL`, contentHash)?.n ??
      0
    );
  }

  representative(contentHash: string): string | null {
    return (
      queryGet<{ id: string | null }>(this.db, `SELECT representative_id AS id FROM variant_families WHERE content_hash = ?`, contentHash)
        ?.id ?? null
    );
  }

  /** Promote (§3): a reversible metadata change; custody does not move. */
  promote(contentHash: string, photoId: string): void {
    run(
      this.db,
      `INSERT INTO variant_families (content_hash, representative_id) VALUES (?, ?)
       ON CONFLICT (content_hash) DO UPDATE SET representative_id = excluded.representative_id`,
      contentHash,
      photoId,
    );
  }

  /**
   * Inserts the duplicate row (metadata copied as a starting point, the
   * overrides above applied), its ledger row, its album seats, and a copy
   * of the byte-subject provenance record, in one transaction. The caller
   * appends the root edit revision and bakes the derivatives.
   */
  duplicate(source: PhotoRecord, id: string, now: string): void {
    const columns = queryAll<{ name: string }>(this.db, `PRAGMA table_info(photos)`).map((column) => column.name);
    const targets = columns.map((column) => `"${column}"`).join(', ');
    const values = columns.map((column) => OVERRIDDEN_COLUMNS[column] ?? `"${column}"`).join(', ');
    this.db.transaction(() => {
      runNamed(this.db, `INSERT INTO photos (${targets}) SELECT ${values} FROM photos WHERE id = @sourceId`, {
        id,
        now,
        derivativeKey: variantDerivativeKey(id, source.contentHash),
        sourceId: source.id,
      });
      run(this.db, `INSERT INTO sync_ledger (photo_id, status, dirty) VALUES (?, 'local', 1)`, id);
      run(
        this.db,
        `INSERT INTO album_photos (album_id, photo_id, position)
         SELECT ap.album_id, ?, (SELECT coalesce(max(x.position), -1) + 1 FROM album_photos x WHERE x.album_id = ap.album_id)
           FROM album_photos ap WHERE ap.photo_id = ?`,
        id,
        source.id,
      );
      run(
        this.db,
        `INSERT INTO photo_provenance (photo_id, subject_hash, evaluator, evaluated_at, tier, evidence)
         SELECT ?, subject_hash, evaluator, evaluated_at, tier, evidence FROM photo_provenance WHERE photo_id = ?`,
        id,
        source.id,
      );
    })();
  }

  /** Backup snapshot (§7): every family whose representative the manifest
   * carries — live, or trashed with a synced/offloaded copy, the same rule
   * as the photo snapshot — so the manifest's link check never rejects a
   * family over a row the manifest does not list. A family whose
   * representative is not carried is simply not recorded; Promote is
   * reversible metadata and restore leaves it unset. */
  familiesSnapshot(): readonly VariantFamilyRow[] {
    return queryAll<{ content_hash: string; representative_id: string }>(
      this.db,
      `SELECT f.content_hash, f.representative_id
         FROM variant_families f
         JOIN photos p ON p.id = f.representative_id
         LEFT JOIN sync_ledger l ON l.photo_id = p.id
        WHERE f.representative_id IS NOT NULL
          AND (p.deleted_at IS NULL OR l.status IN ('synced', 'offloaded'))
        ORDER BY f.content_hash`,
    ).map((row) => ({ contentHash: row.content_hash, representativeId: row.representative_id }));
  }

  restoreFamilies(rows: readonly VariantFamilyRow[]): void {
    this.db.transaction(() => {
      for (const row of rows) this.promote(row.contentHash, row.representativeId);
    })();
  }
}
