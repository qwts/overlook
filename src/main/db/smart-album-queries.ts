import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { parseSmartPredicate, type EnumeratedFacet, type SmartPredicate } from '../../shared/library/smart-album.js';
import { buildQueryPlan } from './photo-query.js';
import { queryAll } from './sql.js';

// Read-side Smart Album helpers (#514) that the listing and the backup
// snapshot share. They import nothing from the tree repository so the
// listing module (album-visibility-repository.ts) can use them without a
// cycle; mutations live in smart-album-repository.ts.

export interface StoredSmartAlbum {
  readonly id: string;
  readonly raw: unknown;
  readonly predicate: SmartPredicate | null;
  readonly unsupported: string | null;
}

export function readSmartAlbums(db: BetterSqlite3.Database): Map<string, StoredSmartAlbum> {
  const result = new Map<string, StoredSmartAlbum>();
  for (const row of queryAll<{ id: string; predicate: string | null }>(db, `SELECT id, predicate FROM albums WHERE kind = 'smart'`)) {
    let raw: unknown;
    try {
      raw = row.predicate === null ? null : JSON.parse(row.predicate);
    } catch {
      raw = null;
    }
    const parsed = parseSmartPredicate(raw);
    result.set(row.id, {
      id: row.id,
      raw,
      predicate: parsed.ok ? parsed.predicate : null,
      unsupported: parsed.ok ? null : parsed.reason,
    });
  }
  return result;
}

/** A Smart Album's count comes from the same compiled predicate as its page
 * (ADR-0030 §6) — never from a materialized id list. */
export function smartAlbumCount(db: BetterSqlite3.Database, predicate: SmartPredicate): number {
  const plan = buildQueryPlan({ source: 'all', predicate });
  const row = queryAll<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM ordinary_visible_photos p LEFT JOIN sync_ledger l ON l.photo_id = p.id WHERE ${plan.whereClause}`,
    { ...plan.params },
  )[0];
  return row?.n ?? 0;
}

export interface FacetValue {
  readonly value: string;
  readonly count: number;
}

const FACET_COLUMNS: Readonly<Record<Exclude<EnumeratedFacet, 'tag'>, string>> = {
  fileType: 'file_kind',
  camera: 'camera',
  lens: 'lens',
  location: 'place',
};

/** The values a facet can take in this library, with how many live ordinary
 * photos carry each, for the picker. Tags merge case-insensitively the way
 * photo keywords do. */
export function facetValues(db: BetterSqlite3.Database, facet: EnumeratedFacet, limit = 200): FacetValue[] {
  if (facet === 'tag') {
    return queryAll<FacetValue>(
      db,
      `SELECT min(value) AS value, count(DISTINCT id) AS count FROM (
         SELECT p.id, j.value FROM ordinary_visible_photos p, json_each(p.user_tags) j WHERE p.deleted_at IS NULL
         UNION
         SELECT p.id, j.value FROM ordinary_visible_photos p, json_each(p.imported_keywords) j
          WHERE p.deleted_at IS NULL AND lower(j.value) NOT IN (SELECT lower(value) FROM json_each(p.suppressed_keywords))
       ) GROUP BY lower(value) ORDER BY count DESC, value COLLATE NOCASE LIMIT ${String(limit)}`,
    );
  }
  const column = FACET_COLUMNS[facet];
  return queryAll<FacetValue>(
    db,
    `SELECT ${column} AS value, count(*) AS count FROM ordinary_visible_photos p
      WHERE p.deleted_at IS NULL AND ${column} IS NOT NULL AND ${column} != ''
      GROUP BY ${column} ORDER BY count DESC, value COLLATE NOCASE LIMIT ${String(limit)}`,
  );
}
