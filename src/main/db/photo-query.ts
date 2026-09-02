import { DEFAULT_GALLERY_POLICY, type GalleryPolicy } from '../../shared/library/gallery-policy.js';
import type { LibraryQuery, PageRequest, SelectionRangeRequest } from '../../shared/library/types.js';
export const ORDERINGS = {
  date: { expr: 'COALESCE(p.taken_at, p.imported_at)', dir: 'DESC', cmp: '<' },
  name: { expr: 'lower(p.file_name)', dir: 'ASC', cmp: '>' },
  size: { expr: 'p.bytes', dir: 'DESC', cmp: '<' },
} as const;

export function select(order: keyof typeof ORDERINGS): string {
  return `
  SELECT p.*, l.status AS sync_state, ${ORDERINGS[order].expr} AS sort_key
  FROM ordinary_visible_photos p
  LEFT JOIN sync_ledger l ON l.photo_id = p.id
`;
}

export function selectRanked(): string {
  return `
  SELECT p.*, l.status AS sync_state, photos_fts.rank AS sort_key
  FROM photos_fts
  JOIN photos ph ON ph.rowid = photos_fts.rowid
  JOIN ordinary_visible_photos p ON p.id = ph.id
  LEFT JOIN sync_ledger l ON l.photo_id = p.id
`;
}

export function selectWithProjection(order: keyof typeof ORDERINGS, projection: string): string {
  return `
  SELECT ${projection}, ${ORDERINGS[order].expr} AS sort_key
  FROM ordinary_visible_photos p
  LEFT JOIN sync_ledger l ON l.photo_id = p.id
`;
}

export function selectRankedWithProjection(projection: string): string {
  return `
  SELECT ${projection}, photos_fts.rank AS sort_key
  FROM photos_fts
  JOIN photos ph ON ph.rowid = photos_fts.rowid
  JOIN ordinary_visible_photos p ON p.id = ph.id
  LEFT JOIN sync_ledger l ON l.photo_id = p.id
`;
}

function toFtsMatchQuery(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu);
  if (tokens === null || tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' AND ');
}

/** The RAW source and the RAW filter chip compile to this one clause
 * (ADR-0030 §4: the chip is an accelerator over the same predicate). */
export const RAW_WHERE = `p.file_kind = 'raw'`;

/** Unavailable is derived from the row's typed renderability reasons: a
 * recorded preview failure, or dimensions the decoder could not establish.
 * Repairing either moves the row out of the source with no restart. */
export const UNAVAILABLE_WHERE = `(p.preview_failure IS NOT NULL OR p.dimension_status = 'unavailable')`;

/** Rows whose dimensions are not known. They are never treated as zero
 * megapixels (ADR-0030 §4) and pass every size threshold. */
export const UNKNOWN_DIMENSIONS_WHERE = `(p.dimension_status = 'unavailable' OR p.width <= 0 OR p.height <= 0)`;

export function sourceWhere(source: PageRequest['source']): string {
  switch (source) {
    case 'all':
      return 'p.deleted_at IS NULL';
    case 'favorites':
      return 'p.deleted_at IS NULL AND p.favorite = 1';
    case 'recent':
      return 'p.deleted_at IS NULL AND p.imported_at >= @recentSince';
    case 'raw':
      return `p.deleted_at IS NULL AND ${RAW_WHERE}`;
    case 'offloaded':
      return `p.deleted_at IS NULL AND l.status = 'offloaded'`;
    case 'unavailable':
      return `p.deleted_at IS NULL AND ${UNAVAILABLE_WHERE}`;
    case 'deleted':
      return 'p.deleted_at IS NOT NULL';
  }
}

/** The All Photos inclusion rules as one cursor-friendly clause, or null when
 * no rule is active. Presentation only: nothing but the All Photos page and
 * its count ever applies it. */
export function inclusionWhere(policy: GalleryPolicy): string | null {
  const clauses: string[] = [];
  if (!policy.showUnavailable) clauses.push(`NOT ${UNAVAILABLE_WHERE}`);
  if (policy.minimumMegapixels !== null) clauses.push(`(${UNKNOWN_DIMENSIONS_WHERE} OR p.width * p.height >= @minimumPixels)`);
  return clauses.length === 0 ? null : clauses.join(' AND ');
}

export function inclusionParams(policy: GalleryPolicy): { readonly minimumPixels: number | null } {
  return { minimumPixels: policy.minimumMegapixels === null ? null : Math.round(policy.minimumMegapixels * 1_000_000) };
}

/** sourceWhere('all') with the inclusion rules applied — the single clause
 * behind the All Photos page and its sidebar count (ADR-0030 §6). */
export function allPhotosWhere(policy: GalleryPolicy): string {
  const inclusion = inclusionWhere(policy);
  return inclusion === null ? ALL_PHOTOS_MEMBERSHIP_WHERE : `${ALL_PHOTOS_MEMBERSHIP_WHERE} AND ${inclusion}`;
}

/** Collection visibility (#494, ADR-0030 §2): a photo hidden by every album
 * that contains it leaves the All Photos presentation and nothing else. The
 * flag is maintained transactionally (album-visibility-repository.ts). */
export const HIDDEN_BY_ALBUMS_WHERE = 'p.in_all_photos = 0';
export const ALL_PHOTOS_MEMBERSHIP_WHERE = `${sourceWhere('all')} AND p.in_all_photos = 1`;

/** Inclusion rules govern the All Photos presentation only: an album view,
 * an explicit search, and every other source see the unfiltered rows. */
export function inclusionApplies(request: Pick<LibraryQuery, 'source' | 'albumId' | 'query'>): boolean {
  return request.source === 'all' && request.albumId === undefined && (request.query === undefined || request.query === '');
}

export interface QueryPlan {
  readonly ftsQuery: string | null;
  readonly fromClause: string;
  readonly whereClause: string;
  readonly orderByClause: string;
  readonly params: Readonly<Record<string, string | number | null>>;
}

export function buildQueryPlan(
  request: LibraryQuery | PageRequest | SelectionRangeRequest,
  policy: GalleryPolicy = DEFAULT_GALLERY_POLICY,
): QueryPlan {
  if (request.source === 'recent' && request.recentSince === undefined) {
    throw new Error(`the 'recent' source requires recentSince`);
  }
  const filters: string[] = [];
  if (request.chips?.favorites === true) filters.push('p.favorite = 1');
  if (request.chips?.raw === true) filters.push(RAW_WHERE);
  if (request.chips?.offloaded === true) filters.push(`p.id IN (SELECT photo_id FROM sync_ledger WHERE status = 'offloaded')`);
  if (request.chips?.localOnly === true) filters.push(`p.id IN (SELECT photo_id FROM sync_ledger WHERE status = 'local')`);
  if (request.albumId !== undefined) filters.push('p.id IN (SELECT photo_id FROM album_photos WHERE album_id = @albumId)');
  const ftsQuery = request.query !== undefined && request.query !== '' ? toFtsMatchQuery(request.query) : null;
  if (request.query !== undefined && request.query !== '' && ftsQuery === null) {
    filters.push(
      `(instr(lower(p.file_name), @query) > 0 OR
        instr(lower(COALESCE(p.user_title, '')), @query) > 0 OR
        instr(lower(COALESCE(p.user_description, '')), @query) > 0 OR
        instr(lower(COALESCE(p.metadata_tags_search, '')), @query) > 0 OR
        instr(lower(COALESCE(p.place, '')), @query) > 0 OR
        instr(lower(COALESCE(p.camera, '')), @query) > 0)`,
    );
  }
  if (ftsQuery !== null) filters.push('photos_fts MATCH @ftsQuery');
  const order = request.order ?? 'date';
  const ranked = ftsQuery !== null;
  const base = inclusionApplies(request) ? allPhotosWhere(policy) : sourceWhere(request.source);
  return {
    ftsQuery,
    fromClause: ranked ? selectRanked() : select(order),
    whereClause: `${base}${filters.length > 0 ? ` AND ${filters.join(' AND ')}` : ''}`,
    orderByClause: ranked ? 'ORDER BY rank' : `ORDER BY sort_key ${ORDERINGS[order].dir}, p.id ${ORDERINGS[order].dir}`,
    params: {
      recentSince: request.recentSince ?? null,
      query: request.query?.toLowerCase() ?? null,
      ftsQuery,
      albumId: request.albumId ?? null,
      ...inclusionParams(policy),
    },
  };
}
