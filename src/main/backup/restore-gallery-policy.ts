import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import { isDeepStrictEqual } from 'node:util';

import { readGalleryPolicy, writeGalleryPolicy } from '../db/gallery-policy-repository.js';
import type { RestorableBackupManifest } from './backup-manifest.js';

// All Photos inclusion rules are library data (ADR-0030 §5): a restored
// library must show exactly what the backed-up one showed. Pre-schema-7
// generations carry no policy and keep the migration defaults.

export function restoreGalleryPolicy(db: BetterSqlite3.Database, manifest: RestorableBackupManifest): void {
  if (manifest.schema === 7) writeGalleryPolicy(db, manifest.galleryPolicy);
}

export function galleryPolicyMatches(db: BetterSqlite3.Database, manifest: RestorableBackupManifest): boolean {
  return manifest.schema !== 7 || isDeepStrictEqual(readGalleryPolicy(db), manifest.galleryPolicy);
}
