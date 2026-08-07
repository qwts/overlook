import { z } from 'zod';

import type { ChannelDefinition } from './channels.js';

function channel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

const metadataMode = z.enum(['original', 'overlook', 'none']);
const result = z.object({
  exported: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  previewTranscodes: z.number().int().nonnegative(),
  failures: z.array(z.object({ photoId: z.string(), fileName: z.string(), reason: z.string() })),
});

export const exportChannels = {
  exportPickDestination: channel('export:pick-destination', z.object({}), z.object({ path: z.string().nullable() })),
  exportRun: channel(
    'export:run',
    z.object({
      photoIds: z.array(z.string()).min(1),
      destination: z.string(),
      format: z.enum(['original', 'jpeg']).optional(),
      metadata: metadataMode.optional(),
    }),
    result,
  ),
  exportRunAll: channel('export:run-all', z.object({ destination: z.string().min(1), metadata: metadataMode.optional() }), result),
  exportCancel: channel('export:cancel', z.object({}), z.object({})),
} as const;
