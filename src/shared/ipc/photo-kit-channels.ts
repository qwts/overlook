import { z } from 'zod';

import type { ChannelDefinition, EventDefinition } from './channels.js';
import { exportDisclosureIntentSchema } from './export-channels.js';

function channel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

export const photoKitAuthorizationSchema = z.enum(['not-determined', 'restricted', 'denied', 'authorized', 'limited']);
export const photoKitUnavailableReasonSchema = z.enum(['unsupported-platform', 'unsigned-build', 'native-unavailable']);
export const photoKitAssetSchema = z.object({
  id: z.string().min(1).max(2048),
  fileName: z.string().min(1).max(1024),
  mediaType: z.enum(['image', 'video']),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  createdAt: z.string().datetime().nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
});
const importSummary = z.object({
  imported: z.number().int().nonnegative(),
  moved: z.number().int().nonnegative(),
  retained: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  sidecars: z.number().int().nonnegative(),
});
const exportSummary = z.object({
  exported: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  failures: z.array(z.object({ photoId: z.string(), fileName: z.string(), reason: z.string() })),
});

export const photoKitChannels = {
  photoKitStatus: channel(
    'photo-kit:status',
    z.object({}),
    z.object({
      available: z.boolean(),
      reason: photoKitUnavailableReasonSchema.nullable(),
      importAuthorization: photoKitAuthorizationSchema,
      exportAuthorization: photoKitAuthorizationSchema,
    }),
  ),
  photoKitImportReview: channel(
    'photo-kit:import-review',
    z.object({}),
    z.object({
      status: z.enum(['ready', 'denied', 'restricted', 'unavailable', 'cancelled']),
      authorization: photoKitAuthorizationSchema,
      reviewId: z.string().uuid().nullable(),
      assets: z.array(photoKitAssetSchema).max(5000).readonly(),
    }),
  ),
  photoKitImportRun: channel(
    'photo-kit:import-run',
    z.object({
      reviewId: z.string().uuid(),
      assetIds: z
        .array(z.string().min(1).max(2048))
        .min(1)
        .max(1000)
        .refine((ids) => new Set(ids).size === ids.length),
    }),
    importSummary,
  ),
  photoKitExportRun: channel(
    'photo-kit:export-run',
    z.object({
      photoIds: z
        .array(z.string().min(1))
        .min(1)
        .max(100)
        .refine((ids) => new Set(ids).size === ids.length),
      /** ADR-0032 §6 operation scope (#509); absent = shared destination, nothing widened. */
      disclosure: exportDisclosureIntentSchema.optional(),
    }),
    exportSummary,
  ),
  photoKitCancel: channel('photo-kit:cancel', z.object({}), z.object({})),
} as const;

export const photoKitEvents = {
  photoKitProgress: {
    name: 'photo-kit:progress',
    payload: z.object({
      operation: z.enum(['import', 'export']),
      phase: z.enum(['preparing', 'transferring']),
      done: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
  } satisfies EventDefinition<z.ZodType>,
} as const;

export type PhotoKitAuthorization = z.output<typeof photoKitAuthorizationSchema>;
export type PhotoKitAsset = z.output<typeof photoKitAssetSchema>;
export type PhotoKitUnavailableReason = z.output<typeof photoKitUnavailableReasonSchema>;
