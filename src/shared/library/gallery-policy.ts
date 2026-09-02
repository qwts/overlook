import { z } from 'zod';

// All Photos inclusion rules (#512, ADR-0030 §4/§5). The policy is library
// data: it lives in the encrypted database, rides in the backup manifest, and
// is never trusted from the renderer — main compiles it into the gallery
// predicate. Exclusion is presentation only; custody, backup, albums, export,
// and explicit search never consult it.

/** Minimum-size choices offered by Settings; `null` is "None / show every size". */
export const MINIMUM_MEGAPIXEL_OPTIONS = [1, 2, 4, 8, 12, 20] as const;

export const galleryPolicySchema = z.object({
  /** Unavailable rows stay visible by default: a broken record the user
   * cannot see is a record they cannot fix. */
  showUnavailable: z.boolean(),
  /** Megapixel floor for All Photos, or null for every size. Rows with
   * unknown dimensions are always included regardless of this value. */
  minimumMegapixels: z.number().positive().max(10_000).nullable(),
});

export type GalleryPolicy = z.infer<typeof galleryPolicySchema>;

export const DEFAULT_GALLERY_POLICY: GalleryPolicy = { showUnavailable: true, minimumMegapixels: null };
