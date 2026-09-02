import { z } from 'zod';

// Provenance evidence in the backup manifest (#495, ADR-0031 §5/§7): the
// record of every carried photo that has one, as written. Restore validates
// the shape and the links (a photo in the manifest, one record per photo)
// and stores the record unchanged; a record this app cannot evaluate is
// preserved and reported unsupported rather than dropped.

export const backupManifestProvenanceV12Schema = z.strictObject({
  photoId: z.string().min(1),
  subjectHash: z.string().regex(/^[a-f0-9]{64}$/u, 'expected a lowercase SHA-256 digest'),
  evaluator: z.string().min(1),
  evaluatedAt: z.iso.datetime({ offset: true }),
  tier: z.string().min(1),
  document: z
    .record(z.string(), z.unknown())
    .refine((document) => typeof document['version'] === 'number' && Number.isInteger(document['version']) && document['version'] >= 1, {
      message: 'evidence needs an integer version',
    }),
});

export type BackupManifestProvenanceV12 = z.infer<typeof backupManifestProvenanceV12Schema>;

export interface ProvenanceLinkInput {
  readonly photos: readonly { readonly id: string }[];
  readonly provenance: readonly BackupManifestProvenanceV12[];
}

/** The cross-record checks a schema-12 manifest must pass (issues land on the offending entry). */
export function checkProvenanceLinks(manifest: ProvenanceLinkInput, context: z.RefinementCtx): void {
  const photoIds = new Set(manifest.photos.map((photo) => photo.id));
  const seen = new Set<string>();
  for (const [index, record] of manifest.provenance.entries()) {
    const path = ['provenance', index];
    if (seen.has(record.photoId)) context.addIssue({ code: 'custom', path, message: 'a photo has two provenance records' });
    seen.add(record.photoId);
    if (!photoIds.has(record.photoId)) {
      context.addIssue({ code: 'custom', path, message: 'provenance names a photo the manifest does not carry' });
    }
  }
}
