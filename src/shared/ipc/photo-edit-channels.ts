import { z } from 'zod';

import { editOperationSchema } from '../library/edit-revision.js';

const defineChannel = <TRequest extends z.ZodType, TResponse extends z.ZodType>(name: string, request: TRequest, response: TResponse) => ({
  name,
  request,
  response,
});

const editTransformSchema = z.object({
  quarterTurns: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  flipped: z.boolean(),
  crop: z.object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() }).nullable(),
});

/** A revision as the renderer sees it (#493, ADR-0031 §2): the operations
 * this build understands, the transform they fold to, and why the stack is
 * unsupported when a newer build wrote it. */
export const editRevisionViewSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  createdAt: z.string(),
  operations: z.array(editOperationSchema).readonly(),
  transform: editTransformSchema,
  unsupported: z.string().nullable(),
});

export const editHeadSchema = z.object({
  photoId: z.string(),
  /** Null is the empty root revision: nothing has been saved yet. */
  head: editRevisionViewSchema.nullable(),
  /** Every retained revision, newest first. */
  history: z.array(editRevisionViewSchema.extend({ current: z.boolean() })).readonly(),
});

const editMutationResultSchema = editHeadSchema.extend({
  /** False when the requested stack equals the head (no revision written). */
  changed: z.boolean(),
  /** What happened to the thumb/mid derivatives after the head advanced. */
  derivatives: z.enum(['regenerated', 'unchanged', 'deferred', 'failed']),
  pendingCount: z.number().int().nonnegative(),
});

export const photoEditChannels = {
  photoEditHead: defineChannel('photo:edit-head', z.object({ photoId: z.string().min(1) }), editHeadSchema),
  photoEditSave: defineChannel(
    'photo:edit-save',
    z.object({ photoId: z.string().min(1), operations: z.array(editOperationSchema).max(64) }),
    editMutationResultSchema,
  ),
  photoEditReset: defineChannel('photo:edit-reset', z.object({ photoId: z.string().min(1) }), editMutationResultSchema),
  photoEditRevert: defineChannel(
    'photo:edit-revert',
    z.object({ photoId: z.string().min(1), revisionId: z.string().min(1) }),
    editMutationResultSchema,
  ),
};

export type EditHeadPayload = z.output<typeof editHeadSchema>;
export type EditMutationResult = z.output<typeof editMutationResultSchema>;
