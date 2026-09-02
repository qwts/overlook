import { z } from 'zod';

export const sourceFilterSchema = z.enum(['all', 'favorites', 'recent', 'raw', 'offloaded', 'unavailable', 'deleted']);

export const chipFiltersSchema = z.object({
  favorites: z.boolean().optional(),
  raw: z.boolean().optional(),
  offloaded: z.boolean().optional(),
  localOnly: z.boolean().optional(),
});

export const libraryQuerySchema = z.object({
  source: sourceFilterSchema,
  recentSince: z.string().optional(),
  query: z.string().optional(),
  searchMode: z.enum(['auto', 'keyword', 'semantic']).optional(),
  searchProjection: z.enum(['keyword', 'semantic', 'fused']).optional(),
  chips: chipFiltersSchema.optional(),
  order: z.enum(['date', 'name', 'size']).optional(),
  albumId: z.string().optional(),
});
