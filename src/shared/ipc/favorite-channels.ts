import { z } from 'zod';

import type { ChannelDefinition } from './channels.js';

function channel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

const favoriteMutationResponseSchema = z.object({
  updated: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
});

export const favoriteChannels = {
  libraryToggleFavorite: channel(
    'library:toggle-favorite',
    z.object({ id: z.string().min(1) }),
    z.object({ favorite: z.boolean(), pendingCount: z.number().int().nonnegative() }),
  ),
  libraryToggleFavorites: channel(
    'library:toggle-favorites',
    z.object({ photoIds: z.array(z.string().min(1)).min(1) }),
    favoriteMutationResponseSchema,
  ),
} as const;
