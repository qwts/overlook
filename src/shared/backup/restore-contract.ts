import { z } from 'zod';

export const restoreFailureSchema = z.enum([
  'auth',
  'offline',
  'disk-space',
  'corrupt',
  'wrong-key',
  'unsupported',
  'destructive-authorization',
  'cancelled',
  'io',
]);

export const restoreErrorSchema = z.object({
  reason: restoreFailureSchema,
  message: z.string().min(1),
  phase: z.enum(['discovering', 'downloading', 'rebuilding', 'activating', 'verify-scan']).optional(),
});

export const restoreProgressSchema = z.object({
  stage: z.enum(['discovering', 'downloading', 'rebuilding', 'activating', 'complete']),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  photoId: z.string().nullable(),
});

export const restoreLibrarySummarySchema = z.object({
  libraryId: z.string().min(1),
  generation: z.number().int().positive().nullable(),
  generatedAt: z.string().datetime().nullable(),
  photos: z.number().int().nonnegative().nullable(),
  totalBytes: z.number().int().nonnegative().nullable(),
  albums: z.number().int().nonnegative().nullable(),
  compatibility: z.enum(['compatible', 'unsupported', 'unknown']),
  validation: z.enum(['valid', 'wrong-key', 'corrupt', 'unsupported']),
  fallbackGenerations: z.number().int().nonnegative(),
  resumable: z.boolean(),
});

export const restoreDiscoverResponseSchema = z.object({
  sessionId: z.string().min(1).nullable(),
  libraries: z.array(restoreLibrarySummarySchema).readonly(),
  error: restoreErrorSchema.nullable(),
});

/** An object a partial restore could not recover (#915): absent from the
 * provider or failed decrypt/content-address verification. Reported in full —
 * never just the first — so recovery is one pass, not rediscovery. */
export const restoreMissingObjectSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['original', 'sidecar', 'protected']),
  photoId: z.string().nullable(),
  reason: z.enum(['not-found', 'failed-verification']),
});

export const restoreRunResponseSchema = z.object({
  result: z
    .object({
      libraryId: z.string().min(1),
      generation: z.number().int().positive(),
      photos: z.number().int().nonnegative(),
      resumed: z.boolean(),
      fallbackFromGeneration: z.number().int().positive().nullable(),
      relaunching: z.boolean(),
      missing: z.array(restoreMissingObjectSchema).readonly(),
    })
    .nullable(),
  error: restoreErrorSchema.nullable(),
});

export const restoreVerifyResponseSchema = z.object({
  result: z
    .object({
      verificationId: z.string().min(1),
      libraryId: z.string().min(1),
      generation: z.number().int().positive(),
      photos: z.number().int().nonnegative(),
      verifiedCount: z.number().int().nonnegative(),
      missingCount: z.number().int().nonnegative(),
      corruptCount: z.number().int().nonnegative(),
      missing: z.array(restoreMissingObjectSchema).readonly(),
    })
    .nullable(),
  error: restoreErrorSchema.nullable(),
});

export const restoreTrashRequestSchema = z.object({
  sessionId: z.string().min(1),
  libraryId: z.string().min(1),
  verificationId: z.string().min(1),
  confirmation: z.string().min(1),
});

export const restoreTrashResponseSchema = z.object({
  trashed: z.boolean(),
  error: restoreErrorSchema.nullable(),
});

export type RestoreFailure = z.output<typeof restoreFailureSchema>;
export type RestoreMissingObject = z.output<typeof restoreMissingObjectSchema>;
export type RestoreProgressContract = z.output<typeof restoreProgressSchema>;
export type RestoreLibrarySummary = z.output<typeof restoreLibrarySummarySchema>;
export type RestoreDiscoverResponse = z.output<typeof restoreDiscoverResponseSchema>;
export type RestoreRunResponse = z.output<typeof restoreRunResponseSchema>;
export type RestoreVerifyResponse = z.output<typeof restoreVerifyResponseSchema>;
export type RestoreTrashResponse = z.output<typeof restoreTrashResponseSchema>;
