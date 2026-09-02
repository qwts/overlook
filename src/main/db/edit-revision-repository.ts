import { createHash } from 'node:crypto';

import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll, queryGet, run, runNamed } from './sql.js';
import {
  canonicalJson,
  foldOperations,
  parseEditRevision,
  type EditOperation,
  type EditRevisionDocument,
  type EditTransform,
  IDENTITY_TRANSFORM,
} from '../../shared/library/edit-revision.js';

// Edit revision rows (#493, ADR-0031 §2). Append-only: a revision is never
// updated or deleted while its photo lives; only the head pointer moves.

export interface EditRevisionRow {
  readonly id: string;
  readonly photoId: string;
  readonly parentId: string | null;
  /** Canonical JSON, exactly as stored. */
  readonly document: string;
  readonly hash: string;
  readonly createdAt: string;
}

/** A revision as the renderer and the backup manifest see it. */
export interface EditRevisionView {
  readonly id: string;
  readonly parentId: string | null;
  readonly createdAt: string;
  /** Operations this build understands; empty when the document is unsupported. */
  readonly operations: readonly EditOperation[];
  readonly transform: EditTransform;
  readonly unsupported: string | null;
}

export interface EditHead {
  readonly photoId: string;
  /** Null is the empty root revision (§8): nothing persisted yet. */
  readonly head: EditRevisionView | null;
  readonly history: readonly (EditRevisionView & { readonly current: boolean })[];
}

interface RawRow {
  id: string;
  photo_id: string;
  parent_id: string | null;
  document: string;
  hash: string;
  created_at: string;
}

const toRow = (raw: RawRow): EditRevisionRow => ({
  id: raw.id,
  photoId: raw.photo_id,
  parentId: raw.parent_id,
  document: raw.document,
  hash: raw.hash,
  createdAt: raw.created_at,
});

export function hashEditRevision(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function viewRevision(row: EditRevisionRow): EditRevisionView {
  const parsed = parseEditRevision(row.document);
  if (!parsed.ok) {
    return {
      id: row.id,
      parentId: row.parentId,
      createdAt: row.createdAt,
      operations: [],
      transform: IDENTITY_TRANSFORM,
      unsupported: parsed.reason,
    };
  }
  return {
    id: row.id,
    parentId: row.parentId,
    createdAt: row.createdAt,
    operations: parsed.operations,
    transform: parsed.unsupported === null ? foldOperations(parsed.operations) : IDENTITY_TRANSFORM,
    unsupported: parsed.unsupported,
  };
}

export class EditRevisionRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  headRow(photoId: string): EditRevisionRow | null {
    const raw = queryGet<RawRow>(
      this.db,
      `SELECT r.id, r.photo_id, r.parent_id, r.document, r.hash, r.created_at
         FROM photos p JOIN edit_revisions r ON r.id = p.edit_head
        WHERE p.id = ?`,
      photoId,
    );
    return raw === undefined ? null : toRow(raw);
  }

  get(revisionId: string): EditRevisionRow | null {
    const raw = queryGet<RawRow>(
      this.db,
      `SELECT id, photo_id, parent_id, document, hash, created_at FROM edit_revisions WHERE id = ?`,
      revisionId,
    );
    return raw === undefined ? null : toRow(raw);
  }

  /** Every retained revision of a photo, newest first. */
  list(photoId: string): readonly EditRevisionRow[] {
    return queryAll<RawRow>(
      this.db,
      `SELECT id, photo_id, parent_id, document, hash, created_at FROM edit_revisions WHERE photo_id = @photoId ORDER BY created_at DESC, id DESC`,
      { photoId },
    ).map(toRow);
  }

  head(photoId: string): EditHead {
    const headRow = this.headRow(photoId);
    const head = headRow === null ? null : viewRevision(headRow);
    const history = this.list(photoId).map((row) => ({ ...viewRevision(row), current: row.id === headRow?.id }));
    return { photoId, head, history };
  }

  /** Appends a revision and advances the head in one transaction (§2: Save
   * atomically advances the head; a failure leaves the durable head as it was). */
  append(photoId: string, document: EditRevisionDocument): EditRevisionRow {
    const canonical = canonicalJson(document);
    const hash = hashEditRevision(canonical);
    return this.db.transaction(() => {
      if (queryGet<{ id: string }>(this.db, `SELECT id FROM photos WHERE id = ?`, photoId) === undefined) {
        throw new Error(`photo ${photoId} not found`);
      }
      runNamed(
        this.db,
        `INSERT INTO edit_revisions (id, photo_id, parent_id, document, hash, created_at)
         VALUES (@id, @photoId, @parentId, @document, @hash, @createdAt)`,
        { id: document.id, photoId, parentId: document.parentId, document: canonical, hash, createdAt: document.createdAt },
      );
      run(this.db, `UPDATE photos SET edit_head = ? WHERE id = ?`, document.id, photoId);
      return { id: document.id, photoId, parentId: document.parentId, document: canonical, hash, createdAt: document.createdAt };
    })();
  }

  /** Backup snapshot (§7): every retained revision of the given photos, head flagged. */
  snapshot(photoIds: ReadonlySet<string>): readonly {
    readonly id: string;
    readonly photoId: string;
    readonly parentId: string | null;
    readonly createdAt: string;
    readonly document: Record<string, unknown>;
    readonly current: boolean;
  }[] {
    return queryAll<RawRow & { current: number }>(
      this.db,
      `SELECT r.id, r.photo_id, r.parent_id, r.document, r.hash, r.created_at, (p.edit_head = r.id) AS current
         FROM edit_revisions r JOIN photos p ON p.id = r.photo_id
        ORDER BY r.photo_id, r.created_at, r.id`,
    )
      .filter((raw) => photoIds.has(raw.photo_id))
      .map((raw) => ({
        id: raw.id,
        photoId: raw.photo_id,
        parentId: raw.parent_id,
        createdAt: raw.created_at,
        document: JSON.parse(raw.document) as Record<string, unknown>,
        current: raw.current === 1,
      }));
  }

  /** Restore (§7/§8): writes carried revisions unchanged and re-points heads. */
  restore(
    revisions: readonly {
      readonly id: string;
      readonly photoId: string;
      readonly parentId: string | null;
      readonly createdAt: string;
      readonly document: Record<string, unknown>;
      readonly current: boolean;
    }[],
  ): void {
    this.db.transaction(() => {
      // Parents first so the self-reference holds under foreign keys.
      const pending = new Map(revisions.map((revision) => [revision.id, revision]));
      const written = new Set<string>();
      const write = (id: string): void => {
        const revision = pending.get(id);
        if (revision === undefined || written.has(id)) return;
        if (revision.parentId !== null) write(revision.parentId);
        const canonical = canonicalJson(revision.document);
        runNamed(
          this.db,
          `INSERT INTO edit_revisions (id, photo_id, parent_id, document, hash, created_at)
           VALUES (@id, @photoId, @parentId, @document, @hash, @createdAt)`,
          {
            id: revision.id,
            photoId: revision.photoId,
            parentId: revision.parentId,
            document: canonical,
            hash: hashEditRevision(canonical),
            createdAt: revision.createdAt,
          },
        );
        written.add(id);
      };
      for (const revision of revisions) write(revision.id);
      for (const revision of revisions) {
        if (revision.current) run(this.db, `UPDATE photos SET edit_head = ? WHERE id = ?`, revision.id, revision.photoId);
      }
    })();
  }
}
