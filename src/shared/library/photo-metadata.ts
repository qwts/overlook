import { z } from 'zod';

const normalizedText = (maximum: number, label: string) =>
  z
    .string()
    .transform((value) => value.normalize('NFKC').trim())
    .pipe(
      z
        .string()
        .max(maximum, `${label} must be ${String(maximum)} characters or fewer`)
        .refine((value) => !/\p{Cc}/u.test(value), `${label} cannot contain control characters`)
        .transform((value) => (value === '' ? null : value)),
    );

export const photoTitleSchema = normalizedText(200, 'title');
export const photoDescriptionSchema = normalizedText(4_000, 'description');

export const photoTagSchema = z
  .string()
  .transform((value) => value.normalize('NFKC').trim().replace(/\s+/gu, ' '))
  .pipe(
    z
      .string()
      .min(1, 'tag cannot be empty')
      .max(64, 'tag must be 64 characters or fewer')
      .refine((value) => !/\p{Cc}/u.test(value), 'tag cannot contain control characters')
      .refine((value) => !/[;,]/u.test(value), 'tag cannot contain a comma or semicolon'),
  );

export const photoTagsSchema = z
  .array(photoTagSchema)
  .max(100)
  .transform((tags) => normalizePhotoTags(tags));

export function photoTagKey(tag: string): string {
  return photoTagSchema.parse(tag).toLowerCase();
}

export function normalizePhotoTags(tags: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const value of tags) {
    const tag = photoTagSchema.parse(value);
    const key = tag.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, tag);
  }
  return [...byKey.values()].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}

export function effectivePhotoTags(
  importedKeywords: readonly string[],
  userTags: readonly string[],
  suppressedKeywords: readonly string[],
): string[] {
  const suppressed = new Set(suppressedKeywords.map((tag) => photoTagKey(tag)));
  return normalizePhotoTags([...importedKeywords.filter((tag) => !suppressed.has(photoTagKey(tag))), ...userTags]);
}

export interface PhotoMetadataFields {
  readonly title: string | null;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly userTags: readonly string[];
  readonly importedKeywords: readonly string[];
  readonly suppressedKeywords: readonly string[];
  readonly metadataVersion: number;
}

export const photoMetadataUpdateSchema = z.strictObject({
  photoIds: z.array(z.string().min(1)).min(1).max(10_000),
  title: z.union([photoTitleSchema, z.null()]).optional(),
  description: z.union([photoDescriptionSchema, z.null()]).optional(),
  addTags: photoTagsSchema.optional(),
  removeTags: photoTagsSchema.optional(),
});

export const photoTagManagementSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('rename'), source: photoTagSchema, target: photoTagSchema }),
  z.strictObject({ operation: z.literal('remove'), source: photoTagSchema }),
]);

export type PhotoMetadataUpdate = z.output<typeof photoMetadataUpdateSchema>;
export type PhotoTagManagement = z.output<typeof photoTagManagementSchema>;
