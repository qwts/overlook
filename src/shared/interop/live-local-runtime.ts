import { z } from 'zod';

export const liveLocalConnectionStatusSchema = z.enum(['unavailable', 'available', 'connecting', 'connected', 'paused', 'incompatible']);

export const liveLocalRuntimeStateSchema = z
  .object({
    status: liveLocalConnectionStatusSchema,
    operation: z.enum(['move', 'sync']).nullable(),
    operationId: z.string().uuid().nullable(),
    remoteSessionId: z.string().uuid().nullable(),
    retryable: z.boolean(),
  })
  .strict();

export const liveLocalOpenSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal('open'),
    operationId: z.string().uuid(),
    remoteSessionId: z.string().uuid(),
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const liveLocalControlSchema = z.discriminatedUnion('type', [
  z.object({ schemaVersion: z.literal(1), type: z.literal('heartbeat') }).strict(),
  z.object({ schemaVersion: z.literal(1), type: z.literal('commit') }).strict(),
  z.object({ schemaVersion: z.literal(1), type: z.literal('cancel') }).strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal('object-ack'),
      path: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict(),
]);

export type LiveLocalRuntimeState = z.output<typeof liveLocalRuntimeStateSchema>;
export type LiveLocalConnectionStatus = z.output<typeof liveLocalConnectionStatusSchema>;
export type LiveLocalOpen = z.output<typeof liveLocalOpenSchema>;
