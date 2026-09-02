import { z } from 'zod';

import { FINGERPRINT_ROTATIONS } from '../library/perceptual-hash.js';

// Perceptual duplicate review over IPC (#650). The review is derived on
// demand from fresh fingerprints — never a stored result — and carries the
// photo records of every group member so the dialog can show them without a
// second round trip. The photo record schema is handed in by the registry so
// this module never imports it back (no cycle).

const defineChannel = <TRequest extends z.ZodType, TResponse extends z.ZodType>(name: string, request: TRequest, response: TResponse) => ({
  name,
  request,
  response,
});

const photoIdSchema = z.string().min(1);

export const fingerprintIndexStatusSchema = z.object({
  total: z.number().int().nonnegative(),
  indexed: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
});

export const duplicatePairSchema = z.object({
  left: photoIdSchema,
  right: photoIdSchema,
  /** Hamming bits of 64 between the closest rotations. */
  distance: z.number().int().min(0).max(64),
  rotation: z.union([
    z.literal(FINGERPRINT_ROTATIONS[0]),
    z.literal(FINGERPRINT_ROTATIONS[1]),
    z.literal(FINGERPRINT_ROTATIONS[2]),
    z.literal(FINGERPRINT_ROTATIONS[3]),
  ]),
});

export function duplicateChannels<TPhoto extends z.ZodType>(photoRecordSchema: TPhoto) {
  const groupSchema = z.object({
    id: photoIdSchema,
    photos: z.array(photoRecordSchema).readonly(),
    pairs: z.array(duplicatePairSchema).readonly(),
  });
  return {
    duplicatesReview: defineChannel(
      'duplicates:review',
      z.object({}),
      z.object({
        version: z.string().min(1),
        threshold: z.number().int().min(0).max(64),
        status: fingerprintIndexStatusSchema,
        groups: z.array(groupSchema).readonly(),
      }),
    ),
    /** Drops every fingerprint and re-indexes; the review answers again as rows return. */
    duplicatesRescan: defineChannel('duplicates:rescan', z.object({}), fingerprintIndexStatusSchema),
  } as const;
}

export const duplicateEvents = {
  duplicatesChanged: { name: 'duplicates:changed', payload: fingerprintIndexStatusSchema },
} as const;
