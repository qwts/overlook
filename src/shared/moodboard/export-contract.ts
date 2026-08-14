import { z } from 'zod';

import { boardSchema } from './board.js';

export const boardExportColorSpaceSchema = z.enum(['srgb', 'display-p3']);
export const boardExportAvailabilitySchema = z.enum(['available', 'offloaded', 'unavailable', 'locked']);

const outputSizeSchema = z
  .object({
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
  })
  .refine(({ width, height }) => width * height <= 32 * 1024 * 1024, {
    message: 'board export is limited to 32 megapixels',
  });

export const boardExportIntentSchema = z.object({
  board: boardSchema,
  availability: z.record(z.string().min(1), boardExportAvailabilitySchema),
  output: outputSizeSchema,
  colorSpace: boardExportColorSpaceSchema,
});

export const boardExportRequestSchema = boardExportIntentSchema.extend({
  destination: z.string().min(1),
});

export const boardExportResultSchema = z.object({
  exported: z.boolean(),
  cancelled: z.boolean(),
  rendered: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  skippedLocked: z.number().int().nonnegative(),
  skippedUnavailable: z.number().int().nonnegative(),
  fileName: z.string().nullable(),
  path: z.string().nullable(),
});

export type BoardExportColorSpace = z.output<typeof boardExportColorSpaceSchema>;
export type BoardExportRequest = z.output<typeof boardExportRequestSchema>;
export type BoardExportResult = z.output<typeof boardExportResultSchema>;
