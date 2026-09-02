import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { ProvenanceRepository } from '../db/provenance-repository.js';
import { canonicalJson } from '../../shared/library/edit-revision.js';
import type { RestorableBackupManifest } from './backup-manifest.js';

// Provenance evidence is library data (ADR-0031 §7): a restored library
// carries every record the backed-up one had, with its evaluation time and
// evaluator intact. A manifest older than schema 12 has none, so its photos
// restore without a record and evaluate lazily on first view — never with
// an invented Unknown.

export function restoreProvenance(db: BetterSqlite3.Database, manifest: RestorableBackupManifest): void {
  if (!('provenance' in manifest)) return;
  new ProvenanceRepository(db).restore(manifest.provenance);
}

function fingerprint(
  records: readonly {
    readonly photoId: string;
    readonly subjectHash: string;
    readonly evaluator: string;
    readonly evaluatedAt: string;
    readonly tier: string;
    readonly document: Record<string, unknown>;
  }[],
): string {
  return [...records]
    .sort((left, right) => left.photoId.localeCompare(right.photoId))
    .map((record) => canonicalJson(record))
    .join('\n');
}

export function provenanceMatches(db: BetterSqlite3.Database, manifest: RestorableBackupManifest): boolean {
  const expected = 'provenance' in manifest ? manifest.provenance : [];
  const actual = new ProvenanceRepository(db).snapshot(new Set(manifest.photos.map((photo) => photo.id)));
  return fingerprint(expected) === fingerprint(actual);
}
