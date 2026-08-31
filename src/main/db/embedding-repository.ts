import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll, queryGet, runNamed } from './sql.js';
import type { LibraryQuery } from '../../shared/library/types.js';
import { buildQueryPlan } from './photo-query.js';

export const EMBEDDING_DIMENSIONS = 512;

export interface EmbeddingCandidate {
  readonly photoId: string;
  readonly contentHash: string;
}

export interface EmbeddingIndexStatus {
  readonly total: number;
  readonly completed: number;
  readonly pending: number;
}

export interface SemanticCandidate {
  readonly photoId: string;
  readonly distance: number;
}

interface EmbeddingIdRow {
  readonly embeddingId: number;
}

interface PhotoIdRow {
  readonly photoId: string;
}

export class EmbeddingCandidateStaleError extends Error {
  override readonly name = 'EmbeddingCandidateStaleError';
}

function embeddingBytes(embedding: Int8Array): Buffer {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new RangeError(`embedding must contain ${String(EMBEDDING_DIMENSIONS)} dimensions`);
  }
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/** SQLCipher-owned vector lifecycle. Query/ranking remains #392's concern. */
export class EmbeddingRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  pending(modelVersion: string, limit: number): readonly EmbeddingCandidate[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('embedding candidate limit must be a positive safe integer');
    return queryAll<{ photoId: string; contentHash: string }>(
      this.db,
      `SELECT p.id AS photoId, p.content_hash AS contentHash
         FROM ordinary_visible_photos p
        WHERE p.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM photo_embeddings e
             WHERE e.photo_id = p.id
               AND e.model_version = @modelVersion
               AND e.content_hash = p.content_hash
          )
          AND NOT EXISTS (
            SELECT 1 FROM photo_embedding_deferrals d
             WHERE d.photo_id = p.id
               AND d.model_version = @modelVersion
               AND d.content_hash = p.content_hash
          )
        ORDER BY p.imported_at, p.id
        LIMIT @limit`,
      { modelVersion, limit },
    );
  }

  status(modelVersion: string): EmbeddingIndexStatus {
    const row = queryGet<{ total: number; completed: number }>(
      this.db,
      `SELECT count(*) AS total,
              count(e.embedding_id) AS completed
         FROM ordinary_visible_photos p
         LEFT JOIN photo_embeddings e
           ON e.photo_id = p.id
          AND e.model_version = @modelVersion
          AND e.content_hash = p.content_hash
         LEFT JOIN photo_embedding_deferrals d
           ON d.photo_id = p.id
          AND d.model_version = @modelVersion
          AND d.content_hash = p.content_hash
        WHERE p.deleted_at IS NULL
          AND d.photo_id IS NULL`,
      { modelVersion },
    ) ?? { total: 0, completed: 0 };
    return { ...row, pending: row.total - row.completed };
  }

  nearest(modelVersion: string, embedding: Int8Array, request: LibraryQuery, limit: number): readonly SemanticCandidate[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('semantic candidate limit must be a positive safe integer');
    const plan = buildQueryPlan({ ...request, query: undefined });
    return queryAll<SemanticCandidate>(
      this.db,
      `SELECT e.photo_id AS photoId,
              vec_distance_cosine(v.embedding, vec_int8(@embedding)) AS distance
         FROM photo_embeddings e
         JOIN photo_embedding_vectors v ON v.embedding_id = e.embedding_id
         JOIN ordinary_visible_photos p ON p.id = e.photo_id
         LEFT JOIN sync_ledger l ON l.photo_id = p.id
        WHERE e.model_version = @modelVersion
          AND e.content_hash = p.content_hash
          AND ${plan.whereClause}
        ORDER BY distance, p.id
        LIMIT @limit`,
      { ...plan.params, modelVersion, embedding: embeddingBytes(embedding), limit },
    );
  }

  put(candidate: EmbeddingCandidate, modelVersion: string, embedding: Int8Array, embeddedAt = new Date().toISOString()): void {
    const bytes = embeddingBytes(embedding);
    this.db.transaction(() => {
      runNamed(
        this.db,
        `DELETE FROM photo_embedding_deferrals
          WHERE photo_id = @photoId AND model_version = @modelVersion`,
        { photoId: candidate.photoId, modelVersion },
      );
      runNamed(
        this.db,
        `DELETE FROM photo_embeddings
          WHERE photo_id = @photoId AND model_version = @modelVersion`,
        { photoId: candidate.photoId, modelVersion },
      );
      const inserted = queryGet<EmbeddingIdRow>(
        this.db,
        `INSERT INTO photo_embeddings (photo_id, content_hash, model_version, embedded_at)
         SELECT @photoId, @contentHash, @modelVersion, @embeddedAt
          WHERE EXISTS (
            SELECT 1 FROM ordinary_visible_photos
             WHERE id = @photoId AND deleted_at IS NULL AND content_hash = @contentHash
          )
         RETURNING embedding_id AS embeddingId`,
        { ...candidate, modelVersion, embeddedAt },
      );
      if (inserted === undefined) {
        throw new EmbeddingCandidateStaleError(`photo ${candidate.photoId} is not eligible for embedding anymore`);
      }
      // sqlite-vec distinguishes INTEGER from REAL bindings; better-sqlite3
      // numbers bind as REAL, so the vec0 integer primary key is explicit.
      this.db
        .prepare(`INSERT INTO photo_embedding_vectors (embedding_id, embedding) VALUES (?, vec_int8(?))`)
        .run(BigInt(inserted.embeddingId), bytes);
    })();
  }

  defer(
    candidate: EmbeddingCandidate,
    modelVersion: string,
    reason: 'derivative-unavailable',
    deferredAt = new Date().toISOString(),
  ): void {
    runNamed(
      this.db,
      `INSERT INTO photo_embedding_deferrals (
         photo_id, content_hash, model_version, reason, deferred_at
       )
       SELECT @photoId, @contentHash, @modelVersion, @reason, @deferredAt
        WHERE EXISTS (
          SELECT 1 FROM ordinary_visible_photos
           WHERE id = @photoId AND deleted_at IS NULL AND content_hash = @contentHash
        )
       ON CONFLICT (photo_id, model_version) DO UPDATE SET
         content_hash = excluded.content_hash,
         reason = excluded.reason,
         deferred_at = excluded.deferred_at`,
      { ...candidate, modelVersion, reason, deferredAt },
    );
  }

  clearDeferred(modelVersion: string, photoIds?: readonly string[]): number {
    if (photoIds !== undefined && photoIds.length === 0) return 0;
    const removed =
      photoIds === undefined
        ? queryAll<PhotoIdRow>(
            this.db,
            `DELETE FROM photo_embedding_deferrals
              WHERE model_version = @modelVersion
             RETURNING photo_id AS photoId`,
            { modelVersion },
          )
        : queryAll<PhotoIdRow>(
            this.db,
            `DELETE FROM photo_embedding_deferrals
              WHERE model_version = @modelVersion
                AND photo_id IN (SELECT value FROM json_each(@photoIds))
             RETURNING photo_id AS photoId`,
            { modelVersion, photoIds: JSON.stringify([...new Set(photoIds)]) },
          );
    return removed.length;
  }

  deleteStale(modelVersion: string): number {
    return this.db.transaction(() => {
      const stale = queryAll<EmbeddingIdRow>(
        this.db,
        `DELETE FROM photo_embeddings
          WHERE model_version = @modelVersion
            AND NOT EXISTS (
              SELECT 1 FROM ordinary_visible_photos p
               WHERE p.id = photo_embeddings.photo_id
                 AND p.deleted_at IS NULL
                 AND p.content_hash = photo_embeddings.content_hash
            )
         RETURNING embedding_id AS embeddingId`,
        { modelVersion },
      );
      runNamed(
        this.db,
        `DELETE FROM photo_embedding_deferrals
          WHERE model_version = @modelVersion
            AND NOT EXISTS (
              SELECT 1 FROM ordinary_visible_photos p
               WHERE p.id = photo_embedding_deferrals.photo_id
                 AND p.deleted_at IS NULL
                 AND p.content_hash = photo_embedding_deferrals.content_hash
            )`,
        { modelVersion },
      );
      return stale.length;
    })();
  }

  deleteModel(modelVersion: string): number {
    return this.db.transaction(() => {
      const removed = queryAll<EmbeddingIdRow>(
        this.db,
        `DELETE FROM photo_embeddings
          WHERE model_version = @modelVersion
         RETURNING embedding_id AS embeddingId`,
        { modelVersion },
      );
      runNamed(this.db, 'DELETE FROM photo_embedding_deferrals WHERE model_version = @modelVersion', { modelVersion });
      return removed.length;
    })();
  }

  deleteOtherModels(modelVersion: string): number {
    return this.db.transaction(() => {
      const removed = queryAll<EmbeddingIdRow>(
        this.db,
        `DELETE FROM photo_embeddings
          WHERE model_version <> @modelVersion
         RETURNING embedding_id AS embeddingId`,
        { modelVersion },
      );
      runNamed(this.db, 'DELETE FROM photo_embedding_deferrals WHERE model_version <> @modelVersion', { modelVersion });
      return removed.length;
    })();
  }

  vectorCount(): number {
    return queryGet<{ count: number }>(this.db, 'SELECT count(*) AS count FROM photo_embedding_vectors')?.count ?? 0;
  }
}
