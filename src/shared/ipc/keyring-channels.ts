import { z } from 'zod';

import type { ChannelDefinition } from './channels.js';
import { KEY_KINDS, KEY_ORIGINS, KEY_REF_PATTERN } from '../keyring/types.js';

function defineChannel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

// The keyring over IPC (#517, ADR-0032 §2). Everything the renderer sees is
// registry fact — references, fingerprints, labels, counts. Key material
// crosses the boundary only as a password-sealed file path in either
// direction; remove carries the Tier D authorization literal when the
// preflight says the key still seals something.

const keyIdSchema = z.number().int().positive();

export const keyringUsageSchema = z.object({
  photos: z.number().int().nonnegative(),
  sidecars: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});

export const keyringEntrySchema = z.object({
  id: keyIdSchema,
  keyRef: z.string().regex(KEY_REF_PATTERN),
  version: z.number().int().positive(),
  kind: z.enum(KEY_KINDS),
  origin: z.enum(KEY_ORIGINS),
  label: z.string().nullable(),
  fingerprint: z.string().nullable(),
  createdAt: z.string(),
  /** Material is on this device; false means every object under it is locked. */
  present: z.boolean(),
  /** The write key — new imports seal under it. */
  active: z.boolean(),
  /** KEY #1 also keys the database and can never be removed. */
  databaseKey: z.boolean(),
  usage: keyringUsageSchema,
});

export const keyringImportReasonSchema = z.enum(['invalid', 'wrong-password', 'matches-nothing', 'no-matching-object', 'mismatch']);
export const keyringRemoveReasonSchema = z.enum(['not-found', 'not-present', 'database-key', 'write-key']);

export const keyringChannels = {
  keyringList: defineChannel('keyring:list', z.object({}), z.object({ keys: z.array(keyringEntrySchema).readonly() })),
  keyringExport: defineChannel(
    'keyring:export',
    // Same main-side floor as the recovery export (security review P3-1).
    z.object({ id: keyIdSchema, password: z.string().min(8).max(1024) }),
    z.object({ path: z.string().nullable() }),
  ),
  keyringPickFile: defineChannel('keyring:pick-file', z.object({}), z.object({ path: z.string().nullable() })),
  keyringImport: defineChannel(
    'keyring:import',
    z.object({ path: z.string().min(1), password: z.string().min(1).max(1024) }),
    z.object({
      outcome: z.enum(['imported', 'already-present', 'refused']),
      keyId: keyIdSchema.nullable(),
      fingerprint: z.string().nullable(),
      /** Photos whose original or sidecar this import unlocked. */
      unlocked: z.number().int().nonnegative(),
      reason: keyringImportReasonSchema.nullable(),
    }),
  ),
  keyringRemovePreflight: defineChannel(
    'keyring:remove-preflight',
    z.object({ id: keyIdSchema }),
    z.object({
      allowed: z.boolean(),
      reason: keyringRemoveReasonSchema.nullable(),
      /** ADR-0023 tier: irreversible whenever the key still seals an object. */
      tier: z.enum(['structural', 'irreversible']),
      usage: keyringUsageSchema,
      entry: keyringEntrySchema.nullable(),
    }),
  ),
  keyringRemove: defineChannel(
    'keyring:remove',
    z.object({ id: keyIdSchema, authorization: z.string().optional() }),
    z.object({
      removed: z.boolean(),
      reason: keyringRemoveReasonSchema.nullable(),
      /** Photos that became locked. */
      locked: z.number().int().nonnegative(),
    }),
  ),
  keyringSetLabel: defineChannel('keyring:set-label', z.object({ id: keyIdSchema, label: z.string().trim().max(80) }), z.object({})),
} as const;
