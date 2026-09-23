import { z } from 'zod';

export const originalRecoveryChannels = {
  photoRecoverOriginal: {
    name: 'photo:recover-original',
    request: z.object({ photoId: z.string().min(1) }),
    response: z.object({ status: z.enum(['recovered', 'unavailable', 'cancelled', 'failed']) }),
  },
};
