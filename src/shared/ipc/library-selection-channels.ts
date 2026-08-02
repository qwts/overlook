import { z } from 'zod';

import type { ChannelDefinition } from './channels.js';
import { chipFiltersSchema, sourceFilterSchema } from './library-query-schemas.js';

function channel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

export const librarySelectionChannels = {
  librarySelectionRange: channel(
    'library:selection-range',
    z.object({
      source: sourceFilterSchema,
      anchorId: z.string().min(1),
      targetId: z.string().min(1),
      recentSince: z.string().optional(),
      query: z.string().optional(),
      chips: chipFiltersSchema.optional(),
      order: z.enum(['date', 'name', 'size']).optional(),
      albumId: z.string().optional(),
    }),
    z.object({ photoIds: z.array(z.string()).readonly() }),
  ),
} as const;
