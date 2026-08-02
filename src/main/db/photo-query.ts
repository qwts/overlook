import type { LibraryQuery } from '../../shared/library/types.js';

// The grid's sort orders (#113). Direction rides along so the keyset cursor
// compares the right way: DESC pages with <, ASC with >.
export const ORDERINGS = {
  date: { expr: 'COALESCE(p.taken_at, p.imported_at)', dir: 'DESC', cmp: '<' },
  name: { expr: 'lower(p.file_name)', dir: 'ASC', cmp: '>' },
  size: { expr: 'p.bytes', dir: 'DESC', cmp: '<' },
} as const;

function from(): string {
  return `
  FROM ordinary_visible_photos p
  LEFT JOIN sync_ledger l ON l.photo_id = p.id
`;
}

// Keep FTS5's rank as a bare ORDER BY expression; wrapping or aliasing it
// prevents the index from streaming ranked results (#390).
function fromRanked(): string {
  return `
  FROM photos_fts
  JOIN photos ph ON ph.rowid = photos_fts.rowid
  JOIN ordinary_visible_photos p ON p.id = ph.id
  LEFT JOIN sync_ledger l ON l.photo_id = p.id
`;
}

export const SELECT = `SELECT p.*, l.status AS sync_state, ${ORDERINGS.date.expr} AS sort_key ${from()}`;

function toFtsMatchQuery(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu);
  if (tokens === null || tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' AND ');
}

export function sourceWhere(source: LibraryQuery['source']): string {
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

export interface LibraryQueryParts {
  readonly fromClause: string;
  readonly whereClause: string;
  readonly ftsQuery: string | null;
  readonly params: {
    readonly recentSince: string | null;
    readonly query: string | null;
    readonly ftsQuery: string | null;
    readonly albumId: string | null;
  };
}

export function queryParts(request: LibraryQuery): LibraryQueryParts {
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

  return {
    fromClause: ftsQuery === null ? from() : fromRanked(),
    whereClause: [sourceWhere(request.source), ...filters].join(' AND '),
    ftsQuery,
    params: {
      recentSince: request.recentSince ?? null,
      query: request.query?.toLowerCase() ?? null,
      ftsQuery,
      albumId: request.albumId ?? null,
    },
  };
}
