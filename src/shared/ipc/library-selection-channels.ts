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

export const librarySelectionChannels = {
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
