import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { EMBEDDING_DIMENSIONS } from '../../src/main/db/embedding-repository.js';
import { EMBEDDING_MODEL_MANIFEST } from '../../src/main/embedding/model-manifest.js';
import { seedSemanticIndex, seedSynthetic } from '../../src/main/library/seed.js';
import {
  reciprocalRankFusion,
  SEMANTIC_CANDIDATE_LIMIT,
  SemanticSearch,
  type SemanticEmbeddingFacade,
} from '../../src/main/library/semantic-search.js';
import type { PageCursor } from '../../src/shared/library/types.js';

function searchWorld(count = 16): {
  readonly db: ReturnType<typeof openLibraryDatabase>;
  readonly search: SemanticSearch;
  readonly embeddings: SemanticEmbeddingFacade;
} {
  const directory = mkdtempSync(join(tmpdir(), 'overlook-semantic-search-'));
  const db = openLibraryDatabase({ path: join(directory, 'library.db'), dbKey: randomBytes(32) });
  seedSynthetic(db, 1, 'semantic-search', count);
  seedSemanticIndex(db, 0);
  return {
    db,
    search: new SemanticSearch(db),
    embeddings: {
      status: () => ({
        phase: 'ready',
        pauseReason: null,
        modelVersion: EMBEDDING_MODEL_MANIFEST.version,
        total: count,
        completed: count,
        pending: 0,
        downloadedBytes: 0,
        downloadBytes: 0,
        error: null,
      }),
      query: () => {
        const embedding = new Int8Array(EMBEDDING_DIMENSIONS);
        embedding[0] = 127;
        return Promise.resolve({ embedding, fallback: null });
      },
    },
  };
}

describe('semantic search ranking', () => {
  test('uses deterministic reciprocal-rank fusion with overlap rewarded', () => {
    const ranked = reciprocalRankFusion(['keyword', 'both'], ['semantic', 'both'], 'fused');
    assert.equal(ranked[0]?.id, 'both');
    assert.deepEqual(
      ranked.slice(1).map(({ id }) => id),
      ['keyword', 'semantic'],
      'equal scores use stable photo ids',
    );
  });

  test('semantic mode does not leak keyword-only candidates', () => {
    assert.deepEqual(
      reciprocalRankFusion(['keyword'], ['semantic'], 'semantic').map(({ id }) => id),
      ['semantic'],
    );
  });

  test('pages semantic and fused results with a stable cursor', async (context) => {
    const world = searchWorld();
    context.after(() => world.db.close());

    const semantic = await world.search.page(
      { source: 'all', limit: 2, query: 'a neon tram at dusk', searchMode: 'semantic' },
      () => world.embeddings,
    );
    assert.equal(semantic.search.appliedMode, 'semantic');
    assert.equal(semantic.photos[0]?.id, '01J8SYNTH0000000');
    assert.notEqual(semantic.nextCursor, null);

    const continuation = await world.search.page(
      { source: 'all', limit: 2, query: 'a neon tram at dusk', searchMode: 'semantic', cursor: semantic.nextCursor ?? undefined },
      () => world.embeddings,
    );
    assert.equal(continuation.search.appliedMode, 'semantic');
    assert.equal(continuation.search.fallbackReason, null);
    assert.ok(continuation.photos.every((photo) => !semantic.photos.some(({ id }) => id === photo.id)));
  });

  test('falls back to keyword results with typed indexing metadata', async (context) => {
    const world = searchWorld();
    context.after(() => world.db.close());
    const fallback: SemanticEmbeddingFacade = {
      status: world.embeddings.status,
      query: () => Promise.resolve({ embedding: null, fallback: 'indexing' }),
    };

    const page = await world.search.page({ source: 'all', limit: 8, query: 'Lisbon', searchMode: 'auto' }, () => fallback);
    assert.equal(page.search.appliedMode, 'keyword');
    assert.equal(page.search.fallbackReason, 'indexing');
    assert.ok(page.photos.length > 0);
  });

  test('pins cursor ranking across semantic availability transitions', async (context) => {
    const world = searchWorld();
    context.after(() => world.db.close());
    const fallback: SemanticEmbeddingFacade = {
      status: world.embeddings.status,
      query: () => Promise.resolve({ embedding: null, fallback: 'indexing' }),
    };

    const keyword = await world.search.page({ source: 'all', limit: 1, query: 'Lisbon', searchMode: 'auto' }, () => fallback);
    assert.deepEqual(keyword.nextCursor?.search, { appliedMode: 'keyword', fallbackReason: 'indexing' });
    let semanticQueries = 0;
    const keywordContinuation = await world.search.page(
      { source: 'all', limit: 1, query: 'Lisbon', searchMode: 'auto', cursor: keyword.nextCursor ?? undefined },
      () => ({ ...world.embeddings, query: (text) => ((semanticQueries += 1), world.embeddings.query(text)) }),
    );
    assert.equal(semanticQueries, 0, 'a keyword cursor never enters the semantic ranker');
    assert.equal(keywordContinuation.search.appliedMode, 'keyword');
    assert.equal(keywordContinuation.search.fallbackReason, 'indexing');
    assert.ok(keywordContinuation.photos.every((photo) => !keyword.photos.some(({ id }) => id === photo.id)));
    assert.ok(
      (
        await world.search.ids({ source: 'all', query: 'Lisbon', searchMode: 'auto', searchProjection: 'keyword' }, () => {
          throw new Error('keyword selection must not enter the semantic ranker');
        })
      ).length > 0,
    );

    const semantic = await world.search.page(
      { source: 'all', limit: 1, query: 'a neon tram at dusk', searchMode: 'semantic' },
      () => world.embeddings,
    );
    assert.deepEqual(semantic.nextCursor?.search, { appliedMode: 'semantic', fallbackReason: null });
    const unavailableContinuation = await world.search.page(
      {
        source: 'all',
        limit: 1,
        query: 'a neon tram at dusk',
        searchMode: 'semantic',
        cursor: semantic.nextCursor ?? undefined,
      },
      () => fallback,
    );
    assert.deepEqual(unavailableContinuation.photos, []);
    assert.equal(unavailableContinuation.nextCursor, null);
    assert.equal(unavailableContinuation.search.appliedMode, 'semantic');
    assert.deepEqual(
      await world.search.ids(
        { source: 'all', query: 'a neon tram at dusk', searchMode: 'semantic', searchProjection: 'semantic' },
        () => fallback,
      ),
      [],
      'selection must not switch a visible semantic projection to keyword results',
    );
  });

  test('keeps Select All and range selection on the semantic projection', async (context) => {
    const world = searchWorld(8);
    context.after(() => world.db.close());

    const ids = await world.search.ids({ source: 'all', query: 'tram', searchMode: 'semantic' }, () => world.embeddings);
    assert.equal(ids.length, 8);
    assert.deepEqual(
      await world.search.selectionRange(
        { source: 'all', query: 'tram', searchMode: 'semantic', anchorId: ids[1]!, targetId: ids[3]! },
        () => world.embeddings,
      ),
      ids.slice(1, 4),
    );
    assert.deepEqual(
      await world.search.selectionRange(
        { source: 'all', query: 'tram', searchMode: 'semantic', anchorId: 'missing', targetId: ids[0]! },
        () => world.embeddings,
      ),
      [],
    );
    assert.ok(
      (
        await world.search.ids({ source: 'all', query: 'Lisbon', searchMode: 'keyword' }, () => {
          throw new Error('keyword selection must stay lazy');
        })
      ).length > 0,
    );
  });

  test('bounds Select All to the exact pageable semantic projection', async (context) => {
    const world = searchWorld(SEMANTIC_CANDIDATE_LIMIT + 1);
    context.after(() => world.db.close());
    const request = {
      source: 'all' as const,
      query: 'tram',
      searchMode: 'semantic' as const,
      searchProjection: 'semantic' as const,
    };
    const ids = await world.search.ids(request, () => world.embeddings);
    assert.equal(ids.length, SEMANTIC_CANDIDATE_LIMIT);

    const paged: string[] = [];
    let cursor: PageCursor | undefined;
    do {
      const page = await world.search.page({ ...request, limit: 500, cursor }, () => world.embeddings);
      paged.push(...page.photos.map(({ id }) => id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    assert.deepEqual(paged, ids);
  });
});
