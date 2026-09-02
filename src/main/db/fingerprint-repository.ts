import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll, queryGet, runNamed } from './sql.js';
import type { FingerprintEntry } from '../../shared/library/duplicate-groups.js';
import { FINGERPRINT_ROTATIONS, isFingerprint, type Fingerprint } from '../../shared/library/perceptual-hash.js';

// Perceptual fingerprint custody (#650). Mirrors the embedding repository:
// a row is fresh only while its algorithm version, derivative key and content
// hash still match the photo, `pending()` is a query-backed cursor over
// ordinary visible photos with no fresh row, and a deferral is a fresh row
// that says why there is no hash yet. Regenerating a derivative in place
// keeps the key, so those passes call `invalidate()` explicitly.

export interface FingerprintCandidate {
  readonly photoId: string;
  readonly contentHash: string;
  /** Where the mid derivative lives (#496): a duplicate's own key, else the hash. */
  readonly derivativeKey: string;
}

export type FingerprintDeferralReason = 'derivative-unavailable' | 'undecodable';

export interface FingerprintIndexStatus {
  readonly total: number;
  readonly indexed: number;
  readonly deferred: number;
  readonly pending: number;
}

interface EntryRow {
  readonly photoId: string;
  readonly contentHash: string;
  readonly variantSourceId: string | null;
  readonly isOriginal: number;
  readonly hash0: string;
  readonly hash90: string;
  readonly hash180: string;
  readonly hash270: string;
}

function changes(db: BetterSqlite3.Database, sql: string, params: Record<string, unknown>): number {
  return db.prepare(sql).run(params).changes;
}

const FRESH = `f.photo_id = p.id AND f.algo_version = @version AND f.derivative_key = p.derivative_key AND f.content_hash = p.content_hash`;

export class FingerprintRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  pending(version: string, limit: number): readonly FingerprintCandidate[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('fingerprint candidate limit must be a positive safe integer');
    return queryAll<FingerprintCandidate>(
      this.db,
      `SELECT p.id AS photoId, p.content_hash AS contentHash, p.derivative_key AS derivativeKey
         FROM ordinary_visible_photos p
        WHERE p.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM photo_fingerprints f WHERE ${FRESH})
        ORDER BY p.imported_at, p.id
        LIMIT @limit`,
      { version, limit },
    );
  }

  status(version: string): FingerprintIndexStatus {
    const row = queryGet<{ total: number; indexed: number; deferred: number }>(
      this.db,
      `SELECT count(*) AS total,
              count(f.hash_0) AS indexed,
              count(f.deferred_reason) AS deferred
         FROM ordinary_visible_photos p
         LEFT JOIN photo_fingerprints f ON ${FRESH}
        WHERE p.deleted_at IS NULL`,
      { version },
    ) ?? { total: 0, indexed: 0, deferred: 0 };
    return { ...row, pending: row.total - row.indexed - row.deferred };
  }

  /** Fresh, hashed entries for every live ordinary photo — the grouping input. */
  entries(version: string): readonly FingerprintEntry[] {
    return queryAll<EntryRow>(
      this.db,
      `SELECT p.id AS photoId, p.content_hash AS contentHash, p.variant_source_id AS variantSourceId,
              p.is_original AS isOriginal,
              f.hash_0 AS hash0, f.hash_90 AS hash90, f.hash_180 AS hash180, f.hash_270 AS hash270
         FROM ordinary_visible_photos p
         JOIN photo_fingerprints f ON ${FRESH}
        WHERE p.deleted_at IS NULL AND f.hash_0 IS NOT NULL
        ORDER BY p.id`,
      { version },
    ).map((row) => ({
      photoId: row.photoId,
      contentHash: row.contentHash,
      variantSourceId: row.variantSourceId,
      isOriginal: row.isOriginal === 1,
      rotations: [row.hash0, row.hash90, row.hash180, row.hash270],
    }));
  }

  /** Stores the rotation set; false when the candidate moved under the indexer. */
  put(candidate: FingerprintCandidate, version: string, rotations: readonly Fingerprint[], computedAt = new Date().toISOString()): boolean {
    if (rotations.length !== FINGERPRINT_ROTATIONS.length || !rotations.every((hash) => isFingerprint(hash))) {
      throw new RangeError('a fingerprint row needs one 16-digit hex hash per rotation');
    }
    return this.write(candidate, version, {
      hash0: rotations[0] ?? null,
      hash90: rotations[1] ?? null,
      hash180: rotations[2] ?? null,
      hash270: rotations[3] ?? null,
      reason: null,
      computedAt,
    });
  }

  /** Records why no hash exists yet; `invalidate()` lifts it. */
  defer(
    candidate: FingerprintCandidate,
    version: string,
    reason: FingerprintDeferralReason,
    computedAt = new Date().toISOString(),
  ): boolean {
    return this.write(candidate, version, { hash0: null, hash90: null, hash180: null, hash270: null, reason, computedAt });
  }

  /** Drops rows for photos whose derivative was regenerated in place. */
  invalidate(photoIds: readonly string[]): number {
    let removed = 0;
    this.db.transaction(() => {
      for (const photoId of photoIds) {
        removed += changes(this.db, `DELETE FROM photo_fingerprints WHERE photo_id = @photoId`, { photoId });
      }
    })();
    return removed;
  }

  /** Rows of another algorithm version are incomparable: drop them. */
  deleteOtherVersions(version: string): number {
    return changes(this.db, `DELETE FROM photo_fingerprints WHERE algo_version <> @version`, { version });
  }

  private write(
    candidate: FingerprintCandidate,
    version: string,
    values: {
      readonly hash0: string | null;
      readonly hash90: string | null;
      readonly hash180: string | null;
      readonly hash270: string | null;
      readonly reason: FingerprintDeferralReason | null;
      readonly computedAt: string;
    },
  ): boolean {
    return this.db.transaction(() => {
      runNamed(this.db, `DELETE FROM photo_fingerprints WHERE photo_id = @photoId`, { photoId: candidate.photoId });
      const inserted = changes(
        this.db,
        `INSERT INTO photo_fingerprints (
           photo_id, derivative_key, content_hash, algo_version, hash_0, hash_90, hash_180, hash_270, deferred_reason, computed_at
         )
         SELECT @photoId, @derivativeKey, @contentHash, @version, @hash0, @hash90, @hash180, @hash270, @reason, @computedAt
          WHERE EXISTS (
            SELECT 1 FROM photos p
             WHERE p.id = @photoId AND p.derivative_key = @derivativeKey AND p.content_hash = @contentHash
          )`,
        { ...candidate, version, ...values },
      );
      return inserted === 1;
    })();
  }
}
