import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { DEFAULT_GALLERY_POLICY, galleryPolicySchema, type GalleryPolicy } from '../../shared/library/gallery-policy.js';
import { queryGet, runNamed } from './sql.js';

interface GalleryPolicyRow {
  readonly show_unavailable: number;
  readonly minimum_megapixels: number | null;
}

/** The library's All Photos inclusion rules (#512). Missing row = defaults. */
export function readGalleryPolicy(db: BetterSqlite3.Database): GalleryPolicy {
  const row = queryGet<GalleryPolicyRow>(db, 'SELECT show_unavailable, minimum_megapixels FROM gallery_policy WHERE id = 1');
  if (row === undefined) return DEFAULT_GALLERY_POLICY;
  return { showUnavailable: row.show_unavailable === 1, minimumMegapixels: row.minimum_megapixels };
}

/** Replaces the policy row; validates first so a hostile IPC payload never
 * reaches SQL. Returns the stored value. */
export function writeGalleryPolicy(db: BetterSqlite3.Database, policy: GalleryPolicy, now: () => Date = () => new Date()): GalleryPolicy {
  const parsed = galleryPolicySchema.parse(policy);
  runNamed(
    db,
    `INSERT INTO gallery_policy (id, show_unavailable, minimum_megapixels, updated_at)
       VALUES (1, @showUnavailable, @minimumMegapixels, @updatedAt)
       ON CONFLICT (id) DO UPDATE SET
         show_unavailable = excluded.show_unavailable,
         minimum_megapixels = excluded.minimum_megapixels,
         updated_at = excluded.updated_at`,
    { showUnavailable: parsed.showUnavailable ? 1 : 0, minimumMegapixels: parsed.minimumMegapixels, updatedAt: now().toISOString() },
  );
  return parsed;
}
