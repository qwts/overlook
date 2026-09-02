import { z } from 'zod';

// Variants over IPC (#496, ADR-0031 §1 + §3). Duplicate creates sibling
// variants over one original asset; a family is every live variant on the
// hash plus the Promoted representative. The photo record schema is handed
// in by the registry so this module never imports it back (no cycle).

const defineChannel = <TRequest extends z.ZodType, TResponse extends z.ZodType>(name: string, request: TRequest, response: TResponse) => ({
  name,
  request,
  response,
});

const photoIdSchema = z.string().min(1);

export const variantDerivativesSchema = z.enum(['regenerated', 'deferred', 'failed']);

export const duplicateResultSchema = z.object({
  created: z
    .array(
      z.object({
        sourceId: photoIdSchema,
        photoId: photoIdSchema,
        /** What happened to the new variant's own thumb/mid derivatives. */
        derivatives: variantDerivativesSchema,
      }),
    )
    .readonly(),
  /** Requested ids that were missing or in Trash. */
  skipped: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
});

export type DuplicateResult = z.infer<typeof duplicateResultSchema>;

export function variantChannels<TPhoto extends z.ZodType>(photoRecordSchema: TPhoto) {
  const familySchema = z.object({
    contentHash: z.string(),
    representativeId: photoIdSchema.nullable(),
    variants: z.array(photoRecordSchema).readonly(),
  });
  return {
    photoDuplicate: defineChannel(
      'photo:duplicate',
      z.object({ photoIds: z.array(photoIdSchema).min(1).max(500).readonly() }),
      duplicateResultSchema,
    ),
    photoVariants: defineChannel('photo:variants', z.object({ photoId: photoIdSchema }), familySchema),
    photoPromoteVariant: defineChannel('photo:promote-variant', z.object({ photoId: photoIdSchema }), familySchema),
  };
}
