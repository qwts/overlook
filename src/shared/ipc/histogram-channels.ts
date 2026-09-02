import { z } from 'zod';

import { HISTOGRAM_BINS } from '../library/histogram.js';

// Inspector histogram over IPC (#498). One lookup per photo: main bins the
// photo's own mid derivative (the edit stack already baked in) off its main
// thread and caches the answer per head revision, so the renderer never
// decodes pixels and the lightbox never waits on it. An unavailable answer
// names why — nothing is drawn from a fabricated or stale source.

const defineChannel = <TRequest extends z.ZodType, TResponse extends z.ZodType>(name: string, request: TRequest, response: TResponse) => ({
  name,
  request,
  response,
});

const binsSchema = z.array(z.number().int().nonnegative()).length(HISTOGRAM_BINS).readonly();

const channelFractionsSchema = z.object({
  red: z.number().min(0).max(1),
  green: z.number().min(0).max(1),
  blue: z.number().min(0).max(1),
});

export const histogramReadySchema = z.object({
  state: z.literal('ready'),
  photoId: z.string(),
  /** The head revision the bins reflect (null = the empty root). */
  revisionId: z.string().nullable(),
  /** Where the samples came from: the mid derivative (sRGB, edits baked). */
  source: z.literal('mid'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  pixels: z.number().int().positive(),
  channels: z.object({ red: binsSchema, green: binsSchema, blue: binsSchema, luma: binsSchema }),
  clipping: z.object({ shadows: channelFractionsSchema, highlights: channelFractionsSchema }),
  /** Stable fingerprint of the bins (tests compare this, not 1024 counts). */
  digest: z.string(),
});

export const histogramUnavailableReasonSchema = z.enum([
  /** No such photo, or no derivative in custody yet. */
  'missing',
  /** The photo's preview already failed (the record says why). */
  'preview-failure',
  /** The derivative is in custody but did not decode. */
  'corrupt',
]);

export const histogramUnavailableSchema = z.object({
  state: z.literal('unavailable'),
  photoId: z.string(),
  reason: histogramUnavailableReasonSchema,
});

export const histogramPayloadSchema = z.discriminatedUnion('state', [histogramReadySchema, histogramUnavailableSchema]);

export const histogramChannels = {
  photoHistogram: defineChannel('photo:histogram', z.object({ photoId: z.string().min(1) }), histogramPayloadSchema),
};

export type HistogramPayload = z.output<typeof histogramPayloadSchema>;
export type HistogramReady = z.output<typeof histogramReadySchema>;
export type HistogramUnavailable = z.output<typeof histogramUnavailableSchema>;
export type HistogramUnavailableReason = z.output<typeof histogramUnavailableReasonSchema>;
