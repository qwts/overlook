import { z } from 'zod';

import {
  MAX_PHOTO_TAGS,
  normalizePhotoTags,
  photoMetadataUpdateSchema,
  photoTagManagementSchema,
  photoTagSchema,
} from '../library/photo-metadata.js';
import type { ChannelDefinition } from './channels.js';

function channel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

const mutationResult = {
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  photoIds: z.array(z.string()).readonly(),
  pendingCount: z.number().int().nonnegative(),
};

const aggregatePhotoTagsSchema = z
  .array(photoTagSchema)
  .max(MAX_PHOTO_TAGS * 10_000)
  .transform((tags) => normalizePhotoTags(tags))
  .readonly();

export const photoMetadataChannels = {
  libraryMetadataUpdate: channel('library:metadata-update', photoMetadataUpdateSchema, z.object(mutationResult)),
  libraryMetadataSummary: channel(
    'library:metadata-summary',
    z.object({ photoIds: z.array(z.string().min(1)).min(1).max(10_000) }),
    z.object({
      found: z.number().int().nonnegative(),
      missing: z.number().int().nonnegative(),
      title: z.object({ mixed: z.boolean(), value: z.string().nullable() }),
      description: z.object({ mixed: z.boolean(), value: z.string().nullable() }),
      commonTags: aggregatePhotoTagsSchema,
      varyingTags: aggregatePhotoTagsSchema,
    }),
  ),
  libraryTagManage: channel('library:tag-manage', photoTagManagementSchema, z.object({ ...mutationResult, merged: z.boolean() })),
  libraryTagSuggestions: channel(
    'library:tag-suggestions',
    z.object({ query: z.string().max(64), limit: z.number().int().positive().max(50).default(10) }),
    z.object({
      tags: z
        .array(z.object({ name: photoTagSchema, count: z.number().int().positive() }))
        .max(50)
        .readonly(),
    }),
  ),
} as const;
