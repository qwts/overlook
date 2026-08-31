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
import { reciprocalRankFusion, SemanticSearch, type SemanticEmbeddingFacade } from '../../src/main/library/semantic-search.js';

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

    const fused = await world.search.page(
      { source: 'all', limit: 2, query: 'Lisbon', searchMode: 'auto', cursor: semantic.nextCursor ?? undefined },
      () => world.embeddings,
    );
    assert.equal(fused.search.appliedMode, 'fused');
    assert.equal(fused.search.fallbackReason, null);
    assert.ok(fused.photos.every((photo) => !semantic.photos.some(({ id }) => id === photo.id)));
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
});
