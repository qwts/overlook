import { z } from 'zod';

export const backupManifestSidecarV6Schema = z.strictObject({
  photoId: z.string().min(1),
  role: z.enum(['xmp', 'aae']),
  fileName: z.string().min(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/u),
  bytes: z.number().int().nonnegative(),
  keyId: z.number().int().positive(),
  blobPath: z.string().min(1),
  ciphertext: z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/u), bytes: z.number().int().positive() }),
});

export const backupManifestSidecarV16Schema = backupManifestSidecarV6Schema.extend({
  ownerId: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/u),
});

export type BackupManifestSidecarV16 = z.infer<typeof backupManifestSidecarV16Schema>;

export function checkSharedSidecars(
  manifest: {
    readonly photos: readonly { readonly id: string; readonly contentHash: string }[];
    readonly sidecars: readonly z.infer<typeof backupManifestSidecarV16Schema>[];
  },
  context: z.RefinementCtx,
): void {
  const photos = new Map(manifest.photos.map((photo) => [photo.id, photo.contentHash]));
  const objects = new Map<string, string>();
  for (const [index, sidecar] of manifest.sidecars.entries()) {
    if (sidecar.blobPath !== `sidecars/${sidecar.ownerId}/${sidecar.hash}`) {
      context.addIssue({
        code: 'custom',
        path: ['sidecars', index, 'blobPath'],
        message: 'sidecar path must derive from its ciphertext owner and hash',
      });
    }
    const identity = JSON.stringify([photos.get(sidecar.photoId), sidecar.hash, sidecar.keyId, sidecar.bytes, sidecar.ciphertext]);
    const previous = objects.get(sidecar.blobPath);
    if (previous !== undefined && previous !== identity) {
      context.addIssue({
        code: 'custom',
        path: ['sidecars', index],
        message: 'shared companion references disagree about original asset or ciphertext',
      });
    }
    objects.set(sidecar.blobPath, identity);
  }
}
