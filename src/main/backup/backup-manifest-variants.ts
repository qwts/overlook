import { z } from 'zod';

// Variant families in backup manifests (#496, ADR-0031 §7). Schema 13 carries
// every carried photo's derivative key and lineage on the photo record (see
// backupManifestPhotoV13Schema) and, here, the Promoted representative per
// original asset. Restore rebuilds each variant's derivatives under its own
// key and verifies the families; a manifest naming a representative that is
// not a carried variant of that asset is corrupt, not partially restorable.

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, 'expected a lowercase SHA-256 digest');

export const backupManifestVariantFamilyV13Schema = z.strictObject({
  contentHash: sha256Schema,
  representativeId: z.string().min(1),
});

export type BackupManifestVariantFamilyV13 = z.infer<typeof backupManifestVariantFamilyV13Schema>;

interface VariantLinkInput {
  readonly photos: readonly { readonly id: string; readonly contentHash: string; readonly derivativeKey?: string | undefined }[];
  readonly variantFamilies: readonly BackupManifestVariantFamilyV13[];
}

export function checkVariantLinks(manifest: VariantLinkInput, context: z.RefinementCtx): void {
  const byId = new Map(manifest.photos.map((photo) => [photo.id, photo]));
  const keys = new Set<string>();
  manifest.photos.forEach((photo, index) => {
    const key = photo.derivativeKey ?? photo.contentHash;
    if (keys.has(key)) {
      context.addIssue({ code: 'custom', path: ['photos', index, 'derivativeKey'], message: `derivative key ${key} is not unique` });
    }
    keys.add(key);
  });
  const hashes = new Set<string>();
  manifest.variantFamilies.forEach((family, index) => {
    if (hashes.has(family.contentHash)) {
      context.addIssue({ code: 'custom', path: ['variantFamilies', index], message: `family ${family.contentHash} listed twice` });
    }
    hashes.add(family.contentHash);
    const representative = byId.get(family.representativeId);
    if (representative === undefined || representative.contentHash !== family.contentHash) {
      context.addIssue({
        code: 'custom',
        path: ['variantFamilies', index, 'representativeId'],
        message: `representative ${family.representativeId} is not a carried variant of ${family.contentHash}`,
      });
    }
  });
}
