import { z } from 'zod';

import { backupManifestPhotoV13Schema } from './backup-manifest-photo.js';

// Schema 14 (#506, ADR-0033 §4): a photo the user keeps on this device only
// is still a library record — album membership, metadata, lineage — but it
// promises no blob. The record says `coverage: 'excluded'` and carries no
// blobPath; an included record keeps its schema-13 byte shape and no
// coverage key. Strict both ways: a record cannot both claim a blob and be
// excluded, and an excluded record cannot name a blob path.

export const backupManifestExcludedPhotoV14Schema = backupManifestPhotoV13Schema
  .omit({ blobPath: true })
  .extend({ coverage: z.literal('excluded') });

export const backupManifestPhotoV14Schema = z.union([backupManifestPhotoV13Schema, backupManifestExcludedPhotoV14Schema]);

/** Library-level disclosure of the excluded population (ADR-0033 §4);
 * cross-checked against the records so a hand-edited manifest cannot
 * understate what the backup does not hold. */
export const backupManifestCoverageV14Schema = z.strictObject({
  excludedCount: z.number().int().nonnegative(),
  excludedBytes: z.number().int().nonnegative(),
});

export type BackupManifestExcludedPhotoV14 = z.infer<typeof backupManifestExcludedPhotoV14Schema>;
export type BackupManifestPhotoV14 = z.infer<typeof backupManifestPhotoV14Schema>;
export type BackupManifestCoverageV14 = z.infer<typeof backupManifestCoverageV14Schema>;

/** The canonical remote path of an original — the only place it is derived. */
export function manifestBlobPath(contentHash: string): string {
  return `blobs/${contentHash.slice(0, 2)}/${contentHash}`;
}

export function isExcludedManifestPhoto(photo: {
  readonly id: string;
  readonly coverage?: unknown;
}): photo is BackupManifestExcludedPhotoV14 {
  return photo.coverage === 'excluded';
}

/** The records that promise a blob — what scans, downloads and completeness
 * checks iterate. Works for every restorable schema: pre-14 records all
 * carry a blobPath. */
export function blobPhotos<P extends { readonly id: string; readonly blobPath?: string }>(
  photos: readonly P[],
): readonly (P & { readonly blobPath: string })[] {
  return photos.filter((photo): photo is P & { readonly blobPath: string } => typeof photo.blobPath === 'string');
}

export function coverageTotals(
  photos: readonly { readonly id: string; readonly bytes: number; readonly coverage?: unknown }[],
): BackupManifestCoverageV14 {
  let excludedCount = 0;
  let excludedBytes = 0;
  for (const photo of photos) {
    if (!isExcludedManifestPhoto(photo)) continue;
    excludedCount += 1;
    excludedBytes += photo.bytes;
  }
  return { excludedCount, excludedBytes };
}

/** The schema-13 view of a schema-14 record set: excluded records regain the
 * path their blob would have, so the older schema's link checks run
 * unchanged. Never used to publish. */
export function asCarriedRecords(photos: readonly BackupManifestPhotoV14[]): readonly z.infer<typeof backupManifestPhotoV13Schema>[] {
  return photos.map((photo) => {
    if (!isExcludedManifestPhoto(photo)) return photo;
    const { coverage: _coverage, ...record } = photo;
    return { ...record, blobPath: manifestBlobPath(photo.contentHash) };
  });
}

export function checkCoverageTotals(
  manifest: { readonly photos: readonly BackupManifestPhotoV14[]; readonly coverage: BackupManifestCoverageV14 },
  context: z.RefinementCtx,
): void {
  const actual = coverageTotals(manifest.photos);
  if (actual.excludedCount !== manifest.coverage.excludedCount || actual.excludedBytes !== manifest.coverage.excludedBytes) {
    context.addIssue({
      code: 'custom',
      path: ['coverage'],
      message: `coverage totals disagree with the records: ${String(actual.excludedCount)} excluded / ${String(actual.excludedBytes)} bytes`,
    });
  }
}
