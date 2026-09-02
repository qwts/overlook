import { z } from 'zod';

import { provenanceEvidenceSchema } from '../library/provenance.js';

const defineChannel = <TRequest extends z.ZodType, TResponse extends z.ZodType>(name: string, request: TRequest, response: TResponse) => ({
  name,
  request,
  response,
});

/** Provenance as the renderer sees it (#495, ADR-0031 §5). */
export const provenancePayloadSchema = z.object({
  photoId: z.string(),
  /** Null when nothing has been evaluated yet or the stored record is unsupported. */
  evidence: provenanceEvidenceSchema.nullable(),
  /** Why a stored record cannot be shown (a newer format); the record is kept. */
  unsupported: z.string().nullable(),
  /** The record predates the current bytes or evaluator; shown, but flagged. */
  stale: z.boolean(),
  /** `deferred`: the original is not local, so a fresh evaluation had to wait. */
  status: z.enum(['evaluated', 'deferred']),
});

export const provenanceChannels = {
  photoProvenance: defineChannel('photo:provenance', z.object({ photoId: z.string().min(1) }), provenancePayloadSchema),
  photoProvenanceRefresh: defineChannel('photo:provenance-refresh', z.object({ photoId: z.string().min(1) }), provenancePayloadSchema),
};

export type ProvenancePayload = z.output<typeof provenancePayloadSchema>;
