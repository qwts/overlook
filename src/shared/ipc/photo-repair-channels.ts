import { z } from 'zod';

export const photoRepairChannels = {
  photoRepair: {
    name: 'photo:repair',
    request: z.object({ photoId: z.string().min(1) }),
    response: z.object({ status: z.enum(['repaired', 'unchanged', 'failed', 'unavailable']) }),
  },
} as const;
export type PhotoRepairResult = z.output<typeof photoRepairChannels.photoRepair.response>;
