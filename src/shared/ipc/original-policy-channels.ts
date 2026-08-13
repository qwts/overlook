import { z } from 'zod';

import { ORIGINAL_DELETE_AUTHORIZATION } from '../destructive-actions.js';
import type { ChannelDefinition, EventDefinition } from './channels.js';

function channel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

export const photoDeleteResultSchema = z.object({
  deleted: z.number().int().nonnegative(),
  protected: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
});

export const purgeSummarySchema = z.object({
  purged: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  protected: z.number().int().nonnegative(),
  remoteFailures: z.number().int().nonnegative(),
});

export const originalPolicyChannels = {
  librarySetOriginal: channel(
    'library:set-original',
    z.object({ photoIds: z.array(z.string().min(1)).min(1), isOriginal: z.boolean() }),
    z.object({
      changed: z.number().int().nonnegative(),
      unchanged: z.number().int().nonnegative(),
      missing: z.number().int().nonnegative(),
      pendingCount: z.number().int().nonnegative(),
    }),
  ),
  libraryOriginalDeletePreflight: channel(
    'library:original-delete-preflight',
    z.object({ photoIds: z.array(z.string().min(1)).min(1) }),
    z.object({
      challengeId: z.string().uuid(),
      count: z.number().int().positive(),
      protected: z.number().int().positive(),
      fileName: z.string().nullable(),
      passwordRequired: z.boolean(),
      expiresAt: z.string().datetime({ offset: true }),
    }),
  ),
  libraryOriginalDeleteAuthorize: channel(
    'library:original-delete-authorize',
    z.object({ challengeId: z.string().uuid(), password: z.string().min(1).max(1024) }),
    z.object({
      ok: z.boolean(),
      reason: z.enum(['wrong-password', 'recovery-required', 'throttled', 'storage-unavailable']).nullable(),
      retryAfterMs: z.number().int().nonnegative(),
    }),
  ),
  libraryOriginalDeleteCommit: channel(
    'library:original-delete-commit',
    z.object({ challengeId: z.string().uuid(), authorization: z.literal(ORIGINAL_DELETE_AUTHORIZATION) }),
    purgeSummarySchema,
  ),
  libraryOriginalDeleteCancel: channel('library:original-delete-cancel', z.object({ challengeId: z.string().uuid() }), z.object({})),
} as const;

export const originalPolicyEvents = {
  originalClassificationChanged: {
    name: 'library:original-classification-changed',
    payload: z.object({ photoIds: z.array(z.string()) }),
  } satisfies EventDefinition<z.ZodType>,
} as const;
