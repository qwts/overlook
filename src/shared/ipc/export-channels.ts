import { z } from 'zod';

import type { ChannelDefinition } from './channels.js';
import { boardExportIntentSchema, boardExportResultSchema } from '../moodboard/export-contract.js';
import { photoCustodyStatusSchema } from '../backup/custody-status.js';

function channel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

const metadataMode = z.enum(['original', 'overlook', 'none']);
const authorization = z.string().uuid();
const selectedExportIntent = z.object({
  operation: z.literal('selected'),
  photoIds: z.array(z.string().min(1)).min(1),
  format: z.enum(['original', 'jpeg']).optional(),
  metadata: metadataMode.optional(),
});
const allExportIntent = z.object({ operation: z.literal('all'), metadata: metadataMode.optional() });
const boardExportIntent = z.object({ operation: z.literal('board'), request: boardExportIntentSchema });
export const exportDestinationIntentSchema = z.discriminatedUnion('operation', [selectedExportIntent, allExportIntent, boardExportIntent]);
const result = z.object({
  exported: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  previewTranscodes: z.number().int().nonnegative(),
  failures: z.array(
    z.object({ photoId: z.string(), fileName: z.string(), reason: z.string(), custody: photoCustodyStatusSchema.optional() }),
  ),
});

export const exportChannels = {
  exportPickDestination: channel(
    'export:pick-destination',
    z.object({ intent: exportDestinationIntentSchema }),
    z.object({ path: z.string().nullable(), authorization: authorization.nullable() }),
  ),
  exportRevokeDestination: channel('export:revoke-destination', z.object({ authorization }), z.object({ revoked: z.boolean() })),
  exportRun: channel('export:run', selectedExportIntent.omit({ operation: true }).extend({ authorization }), result),
  exportRunAll: channel('export:run-all', allExportIntent.omit({ operation: true }).extend({ authorization }), result),
  exportRunBoard: channel('export:run-board', boardExportIntentSchema.extend({ authorization }), boardExportResultSchema),
  exportCancel: channel('export:cancel', z.object({}), z.object({})),
} as const;

export type ExportDestinationIntent = z.output<typeof exportDestinationIntentSchema>;
