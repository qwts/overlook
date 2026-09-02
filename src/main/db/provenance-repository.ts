import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll, queryGet, runNamed } from './sql.js';
import { parseProvenanceEvidence, type ProvenanceEvidence } from '../../shared/library/provenance.js';

// Provenance rows (#495, ADR-0031 §5/§7). A photo has at most one record;
// re-evaluation replaces it. The backup manifest carries the record as
// written and restore writes it back unchanged.

export interface ProvenanceRow {
  readonly photoId: string;
  readonly subjectHash: string;
  readonly evaluator: string;
  readonly evaluatedAt: string;
  readonly tier: string;
  /** The record as stored (parsed JSON), whatever its format version. */
  readonly document: Record<string, unknown>;
}

export interface StoredProvenance extends ProvenanceRow {
  readonly evidence: ProvenanceEvidence | null;
  readonly unsupported: string | null;
}

interface RawRow {
  photo_id: string;
  subject_hash: string;
  evaluator: string;
  evaluated_at: string;
  tier: string;
  evidence: string;
}

const COLUMNS = 'photo_id, subject_hash, evaluator, evaluated_at, tier, evidence';

function toRow(raw: RawRow): ProvenanceRow {
  return {
    photoId: raw.photo_id,
    subjectHash: raw.subject_hash,
    evaluator: raw.evaluator,
    evaluatedAt: raw.evaluated_at,
    tier: raw.tier,
    document: JSON.parse(raw.evidence) as Record<string, unknown>,
  };
}

export class ProvenanceRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  get(photoId: string): StoredProvenance | null {
    const raw = queryGet<RawRow>(this.db, `SELECT ${COLUMNS} FROM photo_provenance WHERE photo_id = ?`, photoId);
    if (raw === undefined) return null;
    const row = toRow(raw);
    return { ...row, ...parseProvenanceEvidence(row.document) };
  }

  put(photoId: string, evidence: ProvenanceEvidence): void {
    this.write({
      photoId,
      subjectHash: evidence.subjectHash,
      evaluator: evidence.evaluator,
      evaluatedAt: evidence.evaluatedAt,
      tier: evidence.tier,
      document: evidence,
    });
  }

  /** Backup snapshot (§7): the record of every carried photo, photo order. */
  snapshot(photoIds: ReadonlySet<string>): readonly ProvenanceRow[] {
    return queryAll<RawRow>(this.db, `SELECT ${COLUMNS} FROM photo_provenance ORDER BY photo_id`)
      .map(toRow)
      .filter((row) => photoIds.has(row.photoId));
  }

  /** Restore: writes the records exactly as the manifest carries them. */
  restore(rows: readonly ProvenanceRow[]): void {
    this.db.transaction(() => {
      for (const row of rows) this.write(row);
    })();
  }

  private write(row: ProvenanceRow): void {
    runNamed(
      this.db,
      `INSERT OR REPLACE INTO photo_provenance (${COLUMNS}) VALUES (@photoId, @subjectHash, @evaluator, @evaluatedAt, @tier, @evidence)`,
      { ...row, evidence: JSON.stringify(row.document) },
    );
  }
}
