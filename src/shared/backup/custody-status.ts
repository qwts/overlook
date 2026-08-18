import { z } from 'zod';

import { providerIdSchema } from './provider-descriptor.js';

export const photoCustodyStateSchema = z.enum([
  'available',
  'disconnected',
  'wrong-account',
  'unavailable',
  'missing-corrupt',
  'provider-required',
  'legacy-unbound',
]);

export const ephemeralFailureReasonSchema = z.enum([
  'not-found',
  'not-offloaded',
  'custody-disconnected',
  'custody-wrong-account',
  'custody-unavailable',
  'remote-missing',
  'verify-failed',
  'cache-full',
]);

export const photoCustodyStatusSchema = z.object({
  state: photoCustodyStateSchema,
  providerId: providerIdSchema.nullable(),
  providerLabel: z.string().min(1).nullable(),
  accountLabel: z.string().min(1).nullable(),
});

export type PhotoCustodyState = z.output<typeof photoCustodyStateSchema>;
export type EphemeralFailureReason = z.output<typeof ephemeralFailureReasonSchema>;
export type PhotoCustodyStatus = z.output<typeof photoCustodyStatusSchema>;

export function custodyStateFromFailure(reason: EphemeralFailureReason): PhotoCustodyState | null {
  switch (reason) {
    case 'custody-disconnected':
      return 'disconnected';
    case 'custody-wrong-account':
      return 'wrong-account';
    case 'custody-unavailable':
    case 'cache-full':
      return 'unavailable';
    case 'not-found':
    case 'remote-missing':
    case 'verify-failed':
      return 'missing-corrupt';
    case 'not-offloaded':
      return null;
  }
}
