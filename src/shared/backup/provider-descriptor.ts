import { z } from 'zod';

export const providerIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/u);

export const providerCapabilitiesSchema = z.object({
  quota: z.enum(['known', 'unknown']),
  verification: z.enum(['server-checksum', 'download-hash']),
  resumableUpload: z.boolean(),
  platforms: z
    .array(z.enum(['darwin', 'win32', 'linux']))
    .min(1)
    .readonly(),
  interactiveAuth: z.boolean(),
  reconnectRequired: z.boolean(),
  accountIdentity: z.literal('stable-subject'),
});

export const providerDescriptorSchema = z.object({
  id: providerIdSchema,
  label: z.string().min(1),
  capabilities: providerCapabilitiesSchema,
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
});

export type ProviderId = z.output<typeof providerIdSchema>;
export type ProviderCapabilities = z.output<typeof providerCapabilitiesSchema>;
export type ProviderDescriptor = z.output<typeof providerDescriptorSchema>;

/** Account-wide capacity from a verified provider quota API (never local disk). */
export const providerCapacitySchema = z.object({
  usedBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
});

/** Prompt connection authority. Remote inventory and quota are deliberately
 * excluded so OAuth completion can render before native capacity loads. */
export const providerConnectionStatusSchema = z.object({
  provider: providerDescriptorSchema,
  connected: z.boolean(),
  /** Non-secret account label captured with the stable provider subject. */
  accountLabel: z.string().min(1).nullable(),
});

/** Informational account capacity from the provider's native quota API.
 * Failures here never change provider authority. iCloud exposes no trustworthy
 * quota API, so Settings links to the system-owned capacity surface instead. */
export const providerCapacityStatusSchema = z.object({
  /** Verified account-wide capacity, or null when no trustworthy source exists. */
  capacity: providerCapacitySchema.nullable(),
  /** Where to route the user for capacity when `capacity` is null. `system-settings`
   * is iCloud's honest fallback (opens macOS System Settings); `none` shows a plain
   * "capacity unavailable" for a provider whose quota call genuinely failed. */
  capacityRoute: z.enum(['system-settings', 'none']),
});

export type ProviderConnectionStatus = z.output<typeof providerConnectionStatusSchema>;
export type ProviderCapacityStatus = z.output<typeof providerCapacityStatusSchema>;
