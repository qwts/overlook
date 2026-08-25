import { z } from 'zod';

import { libraryIdSchema } from './registry.js';

// Library relocation contract (ADR-0022, #483). The journal is the durable
// record of one in-flight move; the marker binds a staging directory to it so
// recovery can tell relocation staging from a user's copy (ADR-0022 §3 — the
// marker, not the directory name, defines staging). Both are main-owned,
// versioned, strict, and fail-loud like the registry: a corrupt journal must
// surface, never self-heal into forgetting a move happened.

/** Journal states, in protocol order (ADR-0022 §2/§4). `copying` covers all
 * work before verification passes (including rename-mode intent); `verified`
 * means every byte and the library-id checked out; `committed` means the
 * registry now points at the destination; `cleaned` is terminal. */
export const relocationStateSchema = z.enum(['copying', 'verified', 'committed', 'cleaned']);
export type RelocationState = z.infer<typeof relocationStateSchema>;

export const relocationModeSchema = z.enum(['copy', 'rename']);
export type RelocationMode = z.infer<typeof relocationModeSchema>;

export const relocationJournalSchema = z
  .object({
    version: z.literal(1),
    libraryId: libraryIdSchema,
    /** Nonce binding this journal to its staging marker — a marker from an
     * older, abandoned attempt never matches a live journal. */
    nonce: z.string().min(1),
    sourcePath: z.string().min(1),
    destPath: z.string().min(1),
    stagingPath: z.string().min(1),
    mode: relocationModeSchema,
    state: relocationStateSchema,
    startedAt: z.string().datetime(),
  })
  .strict();

export type RelocationJournal = z.infer<typeof relocationJournalSchema>;

/** `<staging>/relocation.json` — travels through the activation rename and is
 * deleted only after the registry commit (ADR-0022 §2). */
export const relocationMarkerSchema = z
  .object({
    version: z.literal(1),
    libraryId: libraryIdSchema,
    nonce: z.string().min(1),
  })
  .strict();

export type RelocationMarker = z.infer<typeof relocationMarkerSchema>;

export const RELOCATION_MARKER_FILENAME = 'relocation.json';

/** Stable, user-showable refusal/failure reasons (ADR-0022 §5, the ADR-0010
 * discipline). Preflight reasons block before any bytes move; the rest
 * classify failures mid-protocol. */
export const relocationFailureReasonSchema = z.enum([
  'source-unreadable',
  'destination-not-writable',
  'destination-not-empty',
  'destination-registered',
  'invalid-destination',
  'insufficient-space',
  'unsupported-filesystem',
  'locked',
  'verification-failed',
  'journal-corrupt',
  'cancelled',
  'io-error',
  /* Runtime-level designed refusals (switch parity, ADR-0017 §4/#385): */
  'move-in-progress',
  'app-locked',
  'provider-busy',
  /** Main rejected a missing, expired, revoked, or sender-mismatched picker grant. */
  'authorization-denied',
]);
export type RelocationFailureReason = z.infer<typeof relocationFailureReasonSchema>;

/** `moved-cleanup-pending` is the one sanctioned two-copies end state: the
 * registry committed to the destination but the source could not be removed —
 * both copies are verified, and retry finishes cleanup (ADR-0022 §4 step 7).
 * It is a success variant, never a failure: the move happened. */
export const relocationOutcomeSchema = z.enum(['moved', 'moved-cleanup-pending']);
export type RelocationOutcome = z.infer<typeof relocationOutcomeSchema>;

export const relocationMoveResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    outcome: relocationOutcomeSchema,
    mode: relocationModeSchema,
    items: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    sourcePath: z.string(),
    destPath: z.string(),
  }),
  z.object({ ok: z.literal(false), reason: relocationFailureReasonSchema, detail: z.string() }),
]);

export interface RelocationResult {
  readonly outcome: RelocationOutcome;
  readonly mode: RelocationMode;
  readonly items: number;
  readonly bytes: number;
}

export interface RelocationProgress {
  readonly phase: 'preflight' | 'copying' | 'verifying' | 'committing' | 'cleaning';
  readonly copiedItems: number;
  readonly totalItems: number;
  readonly copiedBytes: number;
  readonly totalBytes: number;
}
