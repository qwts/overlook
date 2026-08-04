import { z } from 'zod';

import type { ChannelDefinition } from './channels.js';

function defineChannel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

export const localTransferStatusSchema = z
  .object({
    enabled: z.boolean(),
    /** Present only while enabled; shown once so the user can pair Image Trail. */
    syncString: z.string().nullable(),
  })
  .strict();

export type LocalTransferStatus = z.output<typeof localTransferStatusSchema>;

export const localTransferChannels = {
  localTransferStatus: defineChannel('local-transfer:status', z.object({}), localTransferStatusSchema),
  localTransferEnable: defineChannel('local-transfer:enable', z.object({}), localTransferStatusSchema),
  localTransferDisable: defineChannel('local-transfer:disable', z.object({}), localTransferStatusSchema),
};
