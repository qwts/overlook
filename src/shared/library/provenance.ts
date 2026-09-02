import { z } from 'zod';

// AI-generation provenance (#495, ADR-0031 §5). Provenance is evidence, not
// a verdict: Overlook records non-collapsible tiers — Verified (a
// cryptographic assertion validates for the exact subject bytes), Declared
// (metadata names a generator or tool, unverified), Detected (a reviewed
// detector reports with its version, confidence, and limits) and Unknown (no
// supported evidence, which never means human-made). An evidence record is
// bound to the subject's content hash and to the evaluator that produced it;
// either changing makes it stale and re-evaluated. Evaluation is local only —
// nothing here can reach a network — and the record format fails closed: a
// newer version is preserved and reported unsupported, never rewritten.

export const PROVENANCE_FORMAT_VERSION = 1;
/** Bump whenever extraction or tier rules change so stored evidence re-evaluates. */
export const PROVENANCE_EVALUATOR = 'overlook-provenance/1';

export const PROVENANCE_TIERS = ['verified', 'declared', 'detected', 'unknown'] as const;
export type ProvenanceTier = (typeof PROVENANCE_TIERS)[number];

export const PROVENANCE_CLAIMS = ['generated', 'edited', 'tool', 'capture'] as const;
export type ProvenanceClaim = (typeof PROVENANCE_CLAIMS)[number];

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, 'expected a lowercase sha256 hex digest');
const timestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u, 'expected an ISO-8601 UTC timestamp');
const text = z.string().min(1).max(2000);

/** A cryptographic credential container (C2PA / Content Credentials). The
 * outcome names what the validator concluded for THESE bytes; a build with
 * no validator reports `unverifiable` and a null validator — presence alone
 * is never Verified. */
export const provenanceCredentialSchema = z.strictObject({
  kind: z.literal('credential'),
  format: z.literal('c2pa'),
  container: z.enum(['jpeg-app11', 'png-caBX', 'isobmff-uuid', 'webp-c2pa', 'xmp-reference']),
  bytes: z.number().int().nonnegative(),
  outcome: z.enum(['valid', 'invalid', 'unverifiable']),
  /** Validator and trust policy that produced the outcome; null without one. */
  validator: z.string().min(1).nullable(),
  reason: text,
});

/** Embedded or sidecar metadata naming a generator, tool, or source type. */
export const provenanceDeclarationSchema = z.strictObject({
  kind: z.literal('declaration'),
  origin: z.enum(['xmp', 'exif', 'png-text', 'xmp-sidecar']),
  field: z.string().min(1).max(200),
  /** The declaration verbatim (bounded); never normalized away. */
  value: text,
  claim: z.enum(PROVENANCE_CLAIMS),
});

/** A reviewed watermark detector or heuristic. Always carries its limits. */
export const provenanceDetectorSchema = z.strictObject({
  kind: z.literal('detector'),
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  result: z.enum(['positive', 'negative', 'inconclusive']),
  confidence: z.number().min(0).max(1).nullable(),
  limits: text,
});

export const provenanceSourceSchema = z.discriminatedUnion('kind', [
  provenanceCredentialSchema,
  provenanceDeclarationSchema,
  provenanceDetectorSchema,
]);

export type ProvenanceCredential = z.infer<typeof provenanceCredentialSchema>;
export type ProvenanceSource = z.infer<typeof provenanceSourceSchema>;

export const provenanceEvidenceSchema = z.strictObject({
  version: z.literal(PROVENANCE_FORMAT_VERSION),
  /** The exact bytes the evidence is about — the photo's original content hash. */
  subjectHash: sha256Schema,
  evaluator: z.string().min(1),
  evaluatedAt: timestampSchema,
  /** Whether any byte or metadata left the device to produce this record. */
  network: z.boolean(),
  tier: z.enum(PROVENANCE_TIERS),
  sources: z.array(provenanceSourceSchema).max(64).readonly(),
});

export type ProvenanceEvidence = z.infer<typeof provenanceEvidenceSchema>;

/** Any evidence shape a newer build may write: an integer version. */
const foreignEvidenceSchema = z.looseObject({ version: z.number().int().positive() });

export type ParsedProvenance =
  { readonly evidence: ProvenanceEvidence; readonly unsupported: null } | { readonly evidence: null; readonly unsupported: string };

/** Parses stored evidence; a newer format is preserved by the caller and
 * reported unsupported (never rewritten, never shown as Unknown). */
export function parseProvenanceEvidence(input: unknown): ParsedProvenance {
  const foreign = foreignEvidenceSchema.safeParse(input);
  if (!foreign.success) return { evidence: null, unsupported: 'evidence record is malformed' };
  if (foreign.data.version > PROVENANCE_FORMAT_VERSION) {
    return { evidence: null, unsupported: `evidence format ${String(foreign.data.version)} is newer than this app` };
  }
  const parsed = provenanceEvidenceSchema.safeParse(input);
  return parsed.success ? { evidence: parsed.data, unsupported: null } : { evidence: null, unsupported: 'evidence record is malformed' };
}

/** The tier a set of sources supports (§5): only a validated credential is
 * Verified; a present-but-unverified or invalid credential and any
 * declaration are Declared; a detector that did not report negative is
 * Detected; nothing is Unknown. Tiers never collapse into each other. */
export function deriveProvenanceTier(sources: readonly ProvenanceSource[]): ProvenanceTier {
  if (sources.some((source) => source.kind === 'credential' && source.outcome === 'valid')) return 'verified';
  if (sources.some((source) => source.kind === 'credential' || source.kind === 'declaration')) return 'declared';
  if (sources.some((source) => source.kind === 'detector' && source.result !== 'negative')) return 'detected';
  return 'unknown';
}

const CLAIM_RANK: Readonly<Record<ProvenanceClaim, number>> = { generated: 3, edited: 2, tool: 1, capture: 0 };

/** The strongest declared claim, for the one-line summary; null without declarations. */
export function strongestClaim(sources: readonly ProvenanceSource[]): ProvenanceClaim | null {
  let best: ProvenanceClaim | null = null;
  for (const source of sources) {
    if (source.kind !== 'declaration') continue;
    if (best === null || CLAIM_RANK[source.claim] > CLAIM_RANK[best]) best = source.claim;
  }
  return best;
}

/** The credential outcome that decides the summary: valid wins, then invalid, then unverifiable. */
export function credentialOutcome(sources: readonly ProvenanceSource[]): ProvenanceCredential['outcome'] | null {
  const outcomes = sources.flatMap((source) => (source.kind === 'credential' ? [source.outcome] : []));
  if (outcomes.includes('valid')) return 'valid';
  if (outcomes.includes('invalid')) return 'invalid';
  return outcomes.length > 0 ? 'unverifiable' : null;
}

export function buildProvenanceEvidence(input: {
  readonly subjectHash: string;
  readonly evaluatedAt: string;
  readonly sources: readonly ProvenanceSource[];
}): ProvenanceEvidence {
  return provenanceEvidenceSchema.parse({
    version: PROVENANCE_FORMAT_VERSION,
    subjectHash: input.subjectHash,
    evaluator: PROVENANCE_EVALUATOR,
    evaluatedAt: input.evaluatedAt,
    network: false,
    tier: deriveProvenanceTier(input.sources),
    sources: input.sources,
  });
}

/** True when the record no longer describes the current bytes or was produced by an older evaluator. */
export function provenanceIsStale(evidence: ProvenanceEvidence, subjectHash: string): boolean {
  return evidence.subjectHash !== subjectHash || evidence.evaluator !== PROVENANCE_EVALUATOR;
}
