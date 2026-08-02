import { z } from 'zod';

export const sourceFilterSchema = z.enum(['all', 'favorites', 'recent', 'offloaded', 'deleted']);

export const chipFiltersSchema = z.object({
  favorites: z.boolean().optional(),
  raw: z.boolean().optional(),
  offloaded: z.boolean().optional(),
  localOnly: z.boolean().optional(),
});
