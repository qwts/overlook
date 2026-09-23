import { z } from 'zod';

import type { ChannelDefinition } from './channels.js';
import { libraryQuerySchema } from './library-query-schemas.js';

function channel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

const photoKeySelectionSchema = z.object({
  photoIds: z.array(z.string()).readonly(),
  locked: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
});
export type PhotoKeySelection = z.output<typeof photoKeySelectionSchema>;

export const librarySelectionChannels = {
  libraryPhotoKeySelection: channel(
    'library:photo-key-selection',
    z.object({ photoIds: z.array(z.string().min(1)) }),
    photoKeySelectionSchema,
  ),
  librarySelectAll: channel('library:select-all', libraryQuerySchema, z.object({ photoIds: z.array(z.string()).readonly() })),
  librarySelectionRange: channel(
    'library:selection-range',
    libraryQuerySchema.extend({
      anchorId: z.string().min(1),
      targetId: z.string().min(1),
    }),
    z.object({ photoIds: z.array(z.string()).readonly() }),
  ),
} as const;
