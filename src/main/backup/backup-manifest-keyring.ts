import { z } from 'zod';

import { keyIdSchema } from './backup-manifest-photo.js';
import { KEY_KINDS, KEY_ORIGINS, KEY_REF_PATTERN } from '../../shared/keyring/types.js';

// Schema 15 (#517, ADR-0032 §2): the manifest carries the keyring registry —
// every key id it names resolved to a stable (key_ref, version) reference
// plus the non-secret facts a restored library needs to keep the identity
// its exported key files carry. Never a secret: the wrapped material rides
// the recovery bootstrap, as before.

export const backupManifestKeyringEntryV15Schema = z.strictObject({
  keyId: keyIdSchema,
  keyRef: z.string().regex(KEY_REF_PATTERN, 'expected a 32-digit hex key reference'),
  version: z.number().int().positive(),
  kind: z.enum(KEY_KINDS),
  origin: z.enum(KEY_ORIGINS),
  label: z.string().max(80).nullable(),
  fingerprint: z.string().nullable(),
});

export type BackupManifestKeyringEntryV15 = z.infer<typeof backupManifestKeyringEntryV15Schema>;

/** Every key a record names must have a registry entry; entries are unique
 * by id and by reference. Extra entries (keys sealing nothing yet) are the
 * registry's business and allowed. */
export function checkKeyringLinks(
  manifest: {
    readonly keyIds: readonly number[];
    readonly keyring: readonly BackupManifestKeyringEntryV15[];
    readonly sidecars: readonly { readonly keyId: number }[];
  },
  context: z.RefinementCtx,
): void {
  const ids = new Set<number>();
  const refs = new Set<string>();
  for (const [index, entry] of manifest.keyring.entries()) {
    if (ids.has(entry.keyId))
      context.addIssue({ code: 'custom', path: ['keyring', index, 'keyId'], message: 'keyring key IDs must be unique' });
    ids.add(entry.keyId);
    const ref = `${entry.keyRef}:${String(entry.version)}`;
    if (refs.has(ref))
      context.addIssue({ code: 'custom', path: ['keyring', index, 'keyRef'], message: 'keyring references must be unique' });
    refs.add(ref);
  }
  for (const [index, keyId] of manifest.keyIds.entries()) {
    if (!ids.has(keyId)) context.addIssue({ code: 'custom', path: ['keyIds', index], message: 'photo key is missing from the keyring' });
  }
  for (const [index, sidecar] of manifest.sidecars.entries()) {
    if (!ids.has(sidecar.keyId)) {
      context.addIssue({ code: 'custom', path: ['sidecars', index, 'keyId'], message: 'sidecar key is missing from the keyring' });
    }
  }
}
