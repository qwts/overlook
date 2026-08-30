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

const liveLocalSyncScopeSchema = z
  .object({
    kind: z.enum(['all', 'selected', 'album']),
    localIds: z.array(z.string().min(1)).readonly(),
  })
  .strict()
  .superRefine((scope, context) => {
    if (new Set(scope.localIds).size !== scope.localIds.length) {
      context.addIssue({ code: 'custom', message: 'Live local Sync scope ids must be unique.' });
    }
    const valid =
      (scope.kind === 'all' && scope.localIds.length === 0) ||
      (scope.kind === 'selected' && scope.localIds.length > 0) ||
      (scope.kind === 'album' && scope.localIds.length === 1);
    if (!valid) context.addIssue({ code: 'custom', message: 'Live local Sync scope ids do not match the selected scope kind.' });
  });

export const liveLocalOperationReviewSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('move') }).strict(),
  z
    .object({
      operation: z.literal('sync'),
      sourceProduct: z.literal('image-trail'),
      targetProduct: z.literal('overlook'),
      direction: z.enum(['image-trail-to-overlook', 'two-way']),
      scope: liveLocalSyncScopeSchema,
    })
    .strict(),
]);

export const liveLocalOpenSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal('open'),
    operationId: z.string().uuid(),
    remoteSessionId: z.string().uuid(),
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/u),
    review: liveLocalOperationReviewSchema,
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
export type LiveLocalOperationReview = z.output<typeof liveLocalOperationReviewSchema>;
