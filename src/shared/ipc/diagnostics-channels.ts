import { z } from 'zod';

import type { ChannelDefinition } from './channels.js';

// Opt-in crash-diagnostics IPC (ADR-0021), split out of the central registry
// to keep it under the file-size budget (the original-policy-channels pattern).
// Behaviour is unchanged — these are the same list/delete/purge/export channels
// and their schemas, verbatim.

function channel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

const diagnosticKindSchema = z.enum([
  'main-process-runtime-error',
  'renderer-process-gone',
  'child-process-gone',
  'renderer-unresponsive',
  'restore-verify-failed',
  'restore-failed',
]);
export const queuedDiagnosticSchema = z.object({
  eventId: z.string().uuid(),
  capturedAt: z.string().datetime({ offset: true }),
  kind: diagnosticKindSchema,
  payload: z.string().max(4096),
  encryptedBytes: z.number().int().nonnegative(),
});
const diagnosticEventIdsSchema = z
  .array(z.string().uuid())
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length);

export const diagnosticsChannels = {
  diagnosticsList: channel('diagnostics:list', z.object({}), z.object({ reports: z.array(queuedDiagnosticSchema) })),
  diagnosticsDelete: channel('diagnostics:delete', z.object({ eventId: z.string().uuid() }), z.object({ deleted: z.boolean() })),
  diagnosticsPurge: channel('diagnostics:purge', z.object({}), z.object({ deleted: z.number().int().nonnegative() })),
  diagnosticsExport: channel(
    'diagnostics:export',
    z.object({ eventIds: diagnosticEventIdsSchema }),
    z.object({ exported: z.boolean(), count: z.number().int().nonnegative() }),
  ),
};
