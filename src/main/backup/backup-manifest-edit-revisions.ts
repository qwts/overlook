import { z } from 'zod';

// Edit revisions in the backup manifest (#493, ADR-0031 §2/§7): every
// retained revision of every carried photo, as written, with the head
// flagged. Restore validates the shape and the links (a photo in the
// manifest, a parent among the photo's own revisions, one head per photo)
// and stores the document unchanged; a document this app cannot evaluate is
// preserved and reported unsupported rather than dropped.

export const backupManifestEditRevisionV11Schema = z.strictObject({
  id: z.string().min(1),
  photoId: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  document: z
    .record(z.string(), z.unknown())
    .refine((document) => typeof document['version'] === 'number' && Number.isInteger(document['version']) && document['version'] >= 1, {
      message: 'revision needs an integer version',
    }),
  current: z.boolean(),
});

export type BackupManifestEditRevisionV11 = z.infer<typeof backupManifestEditRevisionV11Schema>;

export interface EditRevisionLinkInput {
  readonly photos: readonly { readonly id: string }[];
  readonly editRevisions: readonly BackupManifestEditRevisionV11[];
}

/** The cross-record checks a schema-11 manifest must pass (issues land on the offending entry). */
export function checkEditRevisionLinks(manifest: EditRevisionLinkInput, context: z.RefinementCtx): void {
  const photoIds = new Set(manifest.photos.map((photo) => photo.id));
  const byId = new Map<string, BackupManifestEditRevisionV11>();
  const heads = new Set<string>();
  for (const [index, revision] of manifest.editRevisions.entries()) {
    const path = ['editRevisions', index];
    if (byId.has(revision.id)) context.addIssue({ code: 'custom', path, message: 'duplicate revision id' });
    byId.set(revision.id, revision);
    if (!photoIds.has(revision.photoId)) {
      context.addIssue({ code: 'custom', path, message: 'revision names a photo the manifest does not carry' });
    }
    if (revision.current) {
      if (heads.has(revision.photoId)) context.addIssue({ code: 'custom', path, message: 'a photo has two current revisions' });
      heads.add(revision.photoId);
    }
  }
  for (const [index, revision] of manifest.editRevisions.entries()) {
    if (revision.parentId === null) continue;
    const parent = byId.get(revision.parentId);
    if (parent === undefined || parent.photoId !== revision.photoId) {
      context.addIssue({ code: 'custom', path: ['editRevisions', index], message: 'revision parent is not a revision of the same photo' });
    }
  }
}
