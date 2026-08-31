import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { EmbeddingQueryResult, EmbeddingStatus } from '../embedding/embedding-service.js';
import { EMBEDDING_MODEL_MANIFEST } from '../embedding/model-manifest.js';
import { EmbeddingRepository } from '../db/embedding-repository.js';
import { PhotosRepository } from '../db/photos-repository.js';
import type {
  AppliedSearchMode,
  LibraryQuery,
  PageRequest,
  PageResult,
  SearchFallbackReason,
  SelectionRangeRequest,
} from '../../shared/library/types.js';

const RRF_K = 60;
const MIN_CANDIDATES = 1_000;
const MAX_CANDIDATES = 5_000;

interface RankedPhoto {
  readonly id: string;
  readonly score: number;
}

export interface SemanticEmbeddingFacade {
  readonly status: () => EmbeddingStatus;
  readonly query: (text: string) => Promise<EmbeddingQueryResult>;
}

function reciprocalRank(rank: number): number {
  return 1 / (RRF_K + rank);
}

export function reciprocalRankFusion(
  keyword: readonly string[],
  semantic: readonly string[],
  appliedMode: AppliedSearchMode,
): readonly RankedPhoto[] {
  const scores = new Map<string, number>();
  if (appliedMode === 'keyword' || appliedMode === 'fused') {
    keyword.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + reciprocalRank(index + 1)));
  }
  if (appliedMode === 'semantic' || appliedMode === 'fused') {
    semantic.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + reciprocalRank(index + 1)));
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export class SemanticSearch {
  private readonly embeddings: EmbeddingRepository;
  private readonly photos: PhotosRepository;

  constructor(db: BetterSqlite3.Database) {
    this.embeddings = new EmbeddingRepository(db);
    this.photos = new PhotosRepository(db);
  }

  async page(request: PageRequest, getEmbeddingService: () => SemanticEmbeddingFacade): Promise<PageResult> {
    const requestedMode = request.searchMode ?? 'auto';
    if (request.query?.trim() === '' || request.query === undefined || requestedMode === 'keyword') {
      return this.photos.page(request);
    }

    const embeddingService = getEmbeddingService();
    const status = embeddingService.status();
    const metadata = (appliedMode: AppliedSearchMode, fallbackReason: SearchFallbackReason | null) => ({
      requestedMode,
      appliedMode,
      fallbackReason,
      indexed: status.completed,
      total: status.total,
    });
    const keywordPage = (fallbackReason: SearchFallbackReason | null): PageResult => ({
      ...this.photos.page(request),
      search: metadata('keyword', fallbackReason),
    });

    const query = await embeddingService.query(request.query);
    if (query.embedding === null) return keywordPage(query.fallback);

    const candidateLimit = Math.min(MAX_CANDIDATES, Math.max(MIN_CANDIDATES, request.limit * 4));
    try {
      const semantic = this.embeddings
        .nearest(EMBEDDING_MODEL_MANIFEST.version, query.embedding, request, candidateLimit)
        .map(({ photoId }) => photoId);
      const appliedMode: AppliedSearchMode = requestedMode === 'semantic' ? 'semantic' : 'fused';
      const keyword = appliedMode === 'fused' ? this.photos.searchIds(request, candidateLimit) : [];
      const ranked = reciprocalRankFusion(keyword, semantic, appliedMode);
      const afterCursor = ranked.filter((item) => {
        if (request.cursor === undefined) return true;
        const cursorScore = Number(request.cursor.sortKey);
        return item.score < cursorScore || (item.score === cursorScore && item.id.localeCompare(request.cursor.id) > 0);
      });
      const page = afterCursor.slice(0, request.limit);
      const last = page.at(-1);
      return {
        photos: this.photos.records(page.map(({ id }) => id)),
        nextCursor:
          page.length === request.limit && afterCursor.length > request.limit && last !== undefined
            ? { sortKey: last.score, id: last.id }
            : null,
        search: metadata(appliedMode, null),
      };
    } finally {
      query.embedding.fill(0);
    }
  }

  async ids(request: LibraryQuery, getEmbeddingService: () => SemanticEmbeddingFacade): Promise<readonly string[]> {
    const requestedMode = request.searchMode ?? 'auto';
    if (request.query?.trim() === '' || request.query === undefined || requestedMode === 'keyword') {
      return this.photos.selectAllIds(request);
    }
    const embeddingService = getEmbeddingService();
    const query = await embeddingService.query(request.query);
    if (query.embedding === null) return this.photos.selectAllIds(request);
    try {
      const status = embeddingService.status();
      const semantic = this.embeddings
        .nearest(EMBEDDING_MODEL_MANIFEST.version, query.embedding, request, Math.max(1, status.completed))
        .map(({ photoId }) => photoId);
      const appliedMode: AppliedSearchMode = requestedMode === 'semantic' ? 'semantic' : 'fused';
      const keyword = appliedMode === 'fused' ? this.photos.selectAllIds(request) : [];
      return reciprocalRankFusion(keyword, semantic, appliedMode).map(({ id }) => id);
    } finally {
      query.embedding.fill(0);
    }
  }

  async selectionRange(request: SelectionRangeRequest, getEmbeddingService: () => SemanticEmbeddingFacade): Promise<readonly string[]> {
    const ids = await this.ids(request, getEmbeddingService);
    const anchorIndex = ids.indexOf(request.anchorId);
    const targetIndex = ids.indexOf(request.targetId);
    if (anchorIndex === -1 || targetIndex === -1) return [];
    return ids.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1);
  }
}
