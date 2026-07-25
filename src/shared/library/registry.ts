import { z } from 'zod';

// Multi-library registry contract (ADR-0017 §1/§2, #384). The registry file
// is a standalone userData/libraries.json owned by the main process — it is
// deliberately NOT part of the settings store: settings self-heal bad values
// to defaults, which must never silently forget where libraries live. A
// corrupt registry fails loud instead (see src/main/library/library-registry).

/** Crockford-base32 ULID — the library's stable identity (ADR-0007/0017 §2). */
export const libraryIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u, 'library id must be a ULID');

export const libraryEntrySchema = z
  .object({
    id: libraryIdSchema,
    name: z.string().min(1).max(120),
    /** Absolute library directory path (the ADR-0005 layout root). */
    path: z.string().min(1),
    createdAt: z.string().datetime(),
    lastOpenedAt: z.string().datetime().nullable(),
    /** Conservative non-secret summary used while this library is sealed.
     * Omitted for pre-ADR-0028 registry entries. */
    custodyHints: z
      .array(
        z
          .object({
            providerId: z.string().min(1),
            accountId: z.string().min(1),
            soleCustodyItems: z.number().int().nonnegative(),
            soleCustodyBytes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const libraryRegistryFileSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(libraryEntrySchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const entry of file.entries) {
      if (seen.has(entry.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate library id ${entry.id}` });
      }
      seen.add(entry.id);
    }
  });

export type LibraryEntry = z.infer<typeof libraryEntrySchema>;
export type LibraryRegistryFile = z.infer<typeof libraryRegistryFileSchema>;

/** IPC-facing view of an entry: registry fields plus derived runtime status —
 * computed at read time, never persisted (ADR-0017 §1). */
export const libraryDescriptorSchema = libraryEntrySchema
  .extend({
    /** Path failed to stat — Locate/Remove territory (#386). */
    missing: z.boolean(),
    /** This entry is the currently open library. */
    open: z.boolean(),
    /** Hostname holding this library's live advisory lock when it is open in
     * ANOTHER Overlook instance (ADR-0017 §5) — null when free, missing, or
     * open here. Probed at read time, never persisted. */
    lockedBy: z.string().nullable(),
  })
  .strict();

export type LibraryDescriptor = z.infer<typeof libraryDescriptorSchema>;

/** Startup selection (ADR-0017 §1): newest lastOpenedAt wins; never-opened
 * entries lose to opened ones; ties fall back to createdAt then id so the
 * choice is deterministic. Returns undefined for an empty registry. */
export function selectStartupLibrary(entries: readonly LibraryEntry[]): LibraryEntry | undefined {
  return [...entries].sort((a, b) => {
    const aOpened = a.lastOpenedAt ?? '';
    const bOpened = b.lastOpenedAt ?? '';
    if (aOpened !== bOpened) return aOpened > bOpened ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
    return a.id > b.id ? -1 : 1;
  })[0];
}
