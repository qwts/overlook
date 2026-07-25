import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll, queryGet, runNamed } from './sql.js';

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

interface EmbeddingIdRow {
  readonly embeddingId: number;
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
        WHERE p.deleted_at IS NULL`,
      { modelVersion },
    ) ?? { total: 0, completed: 0 };
    return { ...row, pending: row.total - row.completed };
  }

  put(candidate: EmbeddingCandidate, modelVersion: string, embedding: Int8Array, embeddedAt = new Date().toISOString()): void {
    const bytes = embeddingBytes(embedding);
    this.db.transaction(() => {
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
      if (inserted === undefined) throw new Error(`photo ${candidate.photoId} is not eligible for embedding`);
      // sqlite-vec distinguishes INTEGER from REAL bindings; better-sqlite3
      // numbers bind as REAL, so the vec0 integer primary key is explicit.
      this.db
        .prepare(`INSERT INTO photo_embedding_vectors (embedding_id, embedding) VALUES (?, vec_int8(?))`)
        .run(BigInt(inserted.embeddingId), bytes);
    })();
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
      return removed.length;
    })();
  }

  vectorCount(): number {
    return queryGet<{ count: number }>(this.db, 'SELECT count(*) AS count FROM photo_embedding_vectors')?.count ?? 0;
  }
}
