import { z } from 'zod';

import type { ChannelDefinition, EventDefinition } from './channels.js';

const defineChannel = <TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> => ({ name, request, response });

const defineEvent = <TPayload extends z.ZodType>(name: string, payload: TPayload): EventDefinition<TPayload> => ({ name, payload });

export const embeddingStatusSchema = z.object({
  phase: z.enum(['disabled', 'downloading', 'indexing', 'paused', 'ready', 'error']),
  pauseReason: z.enum(['user', 'import', 'backup', 'battery']).nullable(),
  modelVersion: z.string(),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  downloadedBytes: z.number().int().nonnegative(),
  downloadBytes: z.number().int().nonnegative(),
  error: z.string().nullable(),
});

export const embeddingChannels = {
  embeddingStatus: defineChannel('embedding:status', z.object({}), embeddingStatusSchema),
  embeddingEnable: defineChannel('embedding:enable', z.object({ consent: z.literal(true) }), embeddingStatusSchema),
  embeddingDisable: defineChannel('embedding:disable', z.object({}), embeddingStatusSchema),
  embeddingPause: defineChannel('embedding:pause', z.object({}), embeddingStatusSchema),
  embeddingResume: defineChannel('embedding:resume', z.object({}), embeddingStatusSchema),
} as const;

export const embeddingEvents = {
  embeddingStatusChanged: defineEvent('embedding:status-changed', embeddingStatusSchema),
} as const;
