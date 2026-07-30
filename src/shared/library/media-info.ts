import { z } from 'zod';

// Probed media facts per ADR-0026 §1: container/stream properties recorded at
// import from validated signatures — never fabricated, never normalized into
// the original. #547 carries the animated-image fields; video/audio facts
// (#549/#548) extend this record, not the FileKind enum. Playability is NOT
// here by design (ADR-0026 §3): it is derived per device at runtime.
//
// The record is one shape shared by every kind. Animated-image rows written by
// #547 carry only { animated, frameCount, loopCount }; the video/audio fields
// are all optional so those rows keep parsing unchanged under `.strict()`. A
// video/audio row fills the stream fields it can safely probe and leaves the
// rest null — facts or absent, never guesses (§9).

/** Container brand recorded from the signature (§1). "MPEG-TS" for #548. */
export const mediaContainerSchema = z.enum(['MPEG-TS', 'MP4', 'QuickTime', 'WebM', 'Matroska', 'AVI', 'MPEG-PS', 'MPEG-Audio']);

/** One elementary stream the bounded probe inventoried (§2). Codec is the
 * container-native identifier ("H.264", "AAC", "MP2", …); `supported` is a
 * static container-matrix fact, NOT the per-device playability tier (§3). */
export const mediaStreamSchema = z
  .object({
    type: z.enum(['video', 'audio']),
    /** Human codec label for the Inspector; null when the stream type maps to
     * no known codec (still counted, still preserved). */
    codec: z.string().min(1).nullable(),
    /** Profile/level where the probe reached it (e.g. "Main10"); else null. */
    profile: z.string().min(1).nullable(),
  })
  .strict();
export type MediaStream = z.output<typeof mediaStreamSchema>;

export const mediaInfoSchema = z
  .object({
    /** True when the container carries more than one displayable frame. Video
     * rows set this false: video-ness is carried by FileKind, and the grid
     * animated badge / viewer autoplay key off the image kinds, not this. */
    animated: z.boolean(),
    /** Frames counted by the bounded probe; null when the budget cut it short. */
    frameCount: z.number().int().positive().nullable(),
    /** Declared loop count; 0 = loop forever; null = container states none. */
    loopCount: z.number().int().nonnegative().nullable(),

    // ---- video/audio fields (ADR-0026 §1), all optional for back-compat ----
    /** Container brand from the signature; absent on animated-image rows. */
    container: mediaContainerSchema.optional(),
    /** Every elementary stream the bounded probe inventoried, in program order. */
    streams: z.array(mediaStreamSchema).optional(),
    /** Whole-media duration in seconds; null when the probe could not derive it. */
    durationSeconds: z.number().nonnegative().nullable().optional(),
    /** Coded frame dimensions; null when the probe never reached them. */
    codedWidth: z.number().int().positive().nullable().optional(),
    codedHeight: z.number().int().positive().nullable().optional(),
    /** Display dimensions after aspect/rotation; feed the 0×0 sentinel (§1). */
    displayWidth: z.number().int().positive().nullable().optional(),
    displayHeight: z.number().int().positive().nullable().optional(),
    /** Container rotation flag in degrees (0/90/180/270); never re-encoded. */
    rotationDegrees: z
      .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
      .nullable()
      .optional(),
    /** Frame-rate summary; null when unknown. Paired with the VFR flag. */
    frameRate: z.number().positive().nullable().optional(),
    variableFrameRate: z.boolean().optional(),
    /** At least one audio elementary stream is present. */
    audioPresent: z.boolean().optional(),
    /** HDR transfer present (BT.2020 PQ/HLG etc.); null when unknown. */
    hdr: z.boolean().nullable().optional(),
    /** Color transfer label for the Inspector (e.g. "BT.2020 PQ"); else null. */
    colorTransfer: z.string().min(1).nullable().optional(),
    /** The bounded probe hit a budget/count cap before finishing (§9); the
     * item is preserved-only with a "probing" placeholder until a later pass
     * completes (§2). Absent/false = probe ran to a clean end. */
    probeIncomplete: z.boolean().optional(),
  })
  .strict();

export type MediaInfo = z.output<typeof mediaInfoSchema>;

/** Parses a stored media_info JSON column value; null for anything invalid —
 * a corrupt row degrades to "no probed facts", never a crash. */
export function parseMediaInfo(value: string | null): MediaInfo | null {
  if (value === null) return null;
  try {
    return mediaInfoSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Range-served `<video>` MIME per probed container (ADR-0026 §5, #549) —
 * never derived from the extension. Unprobed rows fall back to the remux
 * transport type, preserving the pre-#549 behavior for legacy rows. */
export function videoMimeFor(container: MediaInfo['container'] | null | undefined): string {
  switch (container) {
    case 'MP4':
      return 'video/mp4';
    case 'QuickTime':
      return 'video/quicktime';
    case 'WebM':
      return 'video/webm';
    case 'Matroska':
      return 'video/x-matroska';
    case 'AVI':
      return 'video/x-msvideo';
    case 'MPEG-PS':
      return 'video/mpeg';
    case 'MPEG-Audio':
      return 'audio/mpeg';
    default:
      return 'video/mp2t';
  }
}
