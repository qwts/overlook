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

export function sourceWhere(source: PageRequest['source']): string {
  switch (source) {
    case 'all':
      return 'p.deleted_at IS NULL';
    case 'favorites':
      return 'p.deleted_at IS NULL AND p.favorite = 1';
    case 'recent':
      return 'p.deleted_at IS NULL AND p.imported_at >= @recentSince';
    case 'offloaded':
      return `p.deleted_at IS NULL AND l.status = 'offloaded'`;
    case 'deleted':
      return 'p.deleted_at IS NOT NULL';
  }
}

export interface QueryPlan {
  readonly ftsQuery: string | null;
  readonly fromClause: string;
  readonly whereClause: string;
  readonly orderByClause: string;
  readonly params: Readonly<Record<string, string | number | null>>;
}

export function buildQueryPlan(request: LibraryQuery | PageRequest | SelectionRangeRequest): QueryPlan {
  if (request.source === 'recent' && request.recentSince === undefined) {
    throw new Error(`the 'recent' source requires recentSince`);
  }
  const filters: string[] = [];
  if (request.chips?.favorites === true) filters.push('p.favorite = 1');
  if (request.chips?.raw === true) filters.push(`p.file_kind = 'raw'`);
  if (request.chips?.offloaded === true) filters.push(`p.id IN (SELECT photo_id FROM sync_ledger WHERE status = 'offloaded')`);
  if (request.chips?.localOnly === true) filters.push(`p.id IN (SELECT photo_id FROM sync_ledger WHERE status = 'local')`);
  if (request.albumId !== undefined) filters.push('p.id IN (SELECT photo_id FROM album_photos WHERE album_id = @albumId)');
  const ftsQuery = request.query !== undefined && request.query !== '' ? toFtsMatchQuery(request.query) : null;
  if (request.query !== undefined && request.query !== '' && ftsQuery === null) {
    filters.push(
      `(instr(lower(p.file_name), @query) > 0 OR instr(lower(COALESCE(p.place, '')), @query) > 0 OR instr(lower(COALESCE(p.camera, '')), @query) > 0)`,
    );
  }
  if (ftsQuery !== null) filters.push('photos_fts MATCH @ftsQuery');
  const order = request.order ?? 'date';
  const ranked = ftsQuery !== null;
  return {
    ftsQuery,
    fromClause: ranked ? selectRanked() : select(order),
    whereClause: `${sourceWhere(request.source)}${filters.length > 0 ? ` AND ${filters.join(' AND ')}` : ''}`,
    orderByClause: ranked ? 'ORDER BY rank' : `ORDER BY sort_key ${ORDERINGS[order].dir}, p.id ${ORDERINGS[order].dir}`,
    params: {
      recentSince: request.recentSince ?? null,
      query: request.query?.toLowerCase() ?? null,
      ftsQuery,
      albumId: request.albumId ?? null,
    },
  };
}
