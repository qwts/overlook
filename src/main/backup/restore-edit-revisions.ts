import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { EditRevisionRepository } from '../db/edit-revision-repository.js';
import { canonicalJson, foldOperations, parseEditRevision, type EditTransform } from '../../shared/library/edit-revision.js';
import type { RestorableBackupManifest } from './backup-manifest.js';

// Edit revisions are library data (ADR-0031 §7): a restored library carries
// every retained revision and the same heads the backed-up one had. A
// manifest older than schema 11 has no revisions, so its photos restore with
// the empty root revision (§8) — the NULL head — and their legacy derivatives.

export function restoreEditRevisions(db: BetterSqlite3.Database, manifest: RestorableBackupManifest): void {
  if (!('editRevisions' in manifest)) return;
  new EditRevisionRepository(db).restore(manifest.editRevisions);
}

/**
 * The head transform per carried photo, for baking restored derivatives with
 * the same edits the backed-up library showed. Photos with no head, an empty
 * root head, or a head this build cannot bake (a newer operation) are
 * omitted and rebuild from the original untouched — the same fallback the
 * lightbox uses for an unsupported head.
 */
export function restoredHeadTransforms(manifest: RestorableBackupManifest): ReadonlyMap<string, EditTransform> {
  const transforms = new Map<string, EditTransform>();
  if (!('editRevisions' in manifest)) return transforms;
  for (const revision of manifest.editRevisions) {
    if (!revision.current) continue;
    const parsed = parseEditRevision(revision.document);
    if (!parsed.ok || parsed.unsupported !== null || parsed.operations.length === 0) continue;
    transforms.set(revision.photoId, foldOperations(parsed.operations));
  }
  return transforms;
}

function fingerprint(
  revisions: readonly {
    readonly id: string;
    readonly photoId: string;
    readonly parentId: string | null;
    readonly createdAt: string;
    readonly document: Record<string, unknown>;
    readonly current: boolean;
  }[],
): string {
  return [...revisions]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((revision) => canonicalJson(revision))
    .join('\n');
}

export function editRevisionsMatch(db: BetterSqlite3.Database, manifest: RestorableBackupManifest): boolean {
  const expected = 'editRevisions' in manifest ? manifest.editRevisions : [];
  const actual = new EditRevisionRepository(db).snapshot(new Set(manifest.photos.map((photo) => photo.id)));
  return fingerprint(expected) === fingerprint(actual);
}
