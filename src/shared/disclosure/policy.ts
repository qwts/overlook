import { z } from 'zod';

// Disclosure classes (#509, ADR-0032 §6). Every classifiable metadata field
// carries exactly one class — private never crosses a disclosure boundary,
// shared may cross to named, authorized recipients, public may cross to an
// unauthenticated destination. Local use is not disclosure: private fields
// stay indexed, searchable and actionable on device. This module is the
// single policy: it names the fields, the defaults, the pinned-private set,
// resolves scope (library → collection → photo → operation) and compiles the
// DISCLOSURE PLAN for one boundary crossing. Main recomputes the plan from the
// renderer's intent and builds the payload from it; the renderer never
// supplies a field list, so a stale renderer, a replayed IPC call or a direct
// channel invocation cannot widen disclosure.

export const DISCLOSURE_FIELDS = [
  'title',
  'description',
  'tags',
  'captureTime',
  'camera',
  'lens',
  'provenance',
  'location',
  'ratings',
  'faces',
  'comments',
] as const;
export type DisclosureField = (typeof DISCLOSURE_FIELDS)[number];

export const DISCLOSURE_CLASSES = ['private', 'shared', 'public'] as const;
export type DisclosureClass = (typeof DISCLOSURE_CLASSES)[number];

export const disclosureFieldSchema = z.enum(DISCLOSURE_FIELDS);
export const disclosureClassSchema = z.enum(DISCLOSURE_CLASSES);

export const DISCLOSURE_POLICY_VERSION = 1;

/** §6 defaults: nothing defaults to public; precise location, ratings and
 * face data are private; comments are shared within their space. */
export const DEFAULT_DISCLOSURE_FIELDS: Readonly<Record<DisclosureField, DisclosureClass>> = {
  title: 'shared',
  description: 'shared',
  tags: 'shared',
  captureTime: 'shared',
  camera: 'shared',
  lens: 'shared',
  provenance: 'shared',
  location: 'private',
  ratings: 'private',
  faces: 'private',
  comments: 'shared',
};

export const disclosureFieldClassesSchema = z
  .object({
    title: disclosureClassSchema,
    description: disclosureClassSchema,
    tags: disclosureClassSchema,
    captureTime: disclosureClassSchema,
    camera: disclosureClassSchema,
    lens: disclosureClassSchema,
    provenance: disclosureClassSchema,
    location: disclosureClassSchema,
    ratings: disclosureClassSchema,
    faces: disclosureClassSchema,
    comments: disclosureClassSchema,
  })
  .strict();

export const disclosurePolicySchema = z
  .object({ version: z.literal(DISCLOSURE_POLICY_VERSION), fields: disclosureFieldClassesSchema })
  .strict();
export type DisclosurePolicy = z.output<typeof disclosurePolicySchema>;

export const DEFAULT_DISCLOSURE_POLICY: DisclosurePolicy = { version: DISCLOSURE_POLICY_VERSION, fields: DEFAULT_DISCLOSURE_FIELDS };

/** The pinned-private set: never classifiable by any preference at any
 * scope. Listed by name so the preview and the acceptance doc can show it. */
export const PINNED_PRIVATE = [
  'key material and key references',
  'recovery state',
  'blob addresses and content hashes',
  'protected-album existence, names and counts',
  'app-lock state',
  'provider credentials and account identifiers',
  'per-photo custody and backup-coverage state',
  'biometric-derived data',
  'diagnostics identifiers',
  'participant device secrets',
] as const;

/** The boundaries §6 governs. Backup is not one: ciphertext under the
 * user's own keys carries no classification. */
export const DISCLOSURE_BOUNDARIES = ['export', 'photo-kit', 'llm', 'interop', 'file-provider', 'diagnostics'] as const;
export type DisclosureBoundary = (typeof DISCLOSURE_BOUNDARIES)[number];
export const disclosureBoundarySchema = z.enum(DISCLOSURE_BOUNDARIES);

/** The recipient class of one crossing: a named, authorized recipient
 * (the user's own folder, Apple Photos, a keyed provider, a paired peer)
 * or an unauthenticated destination (publishing). */
export const DISCLOSURE_DESTINATIONS = ['shared', 'public'] as const;
export type DisclosureDestination = (typeof DISCLOSURE_DESTINATIONS)[number];
export const disclosureDestinationSchema = z.enum(DISCLOSURE_DESTINATIONS);

/** What each boundary can carry at all; the plan is compiled over these. */
export const BOUNDARY_FIELDS: Readonly<Record<DisclosureBoundary, readonly DisclosureField[]>> = {
  export: ['title', 'description', 'tags', 'captureTime', 'camera', 'lens', 'location'],
  'photo-kit': ['captureTime', 'camera', 'lens', 'location'],
  llm: ['captureTime', 'camera'],
  interop: ['title', 'captureTime'],
  'file-provider': ['captureTime'],
  diagnostics: [],
};

/** Fields that travel inside the original bytes (EXIF/XMP) and cannot be
 * filtered per field: an operation that carries originals discloses them
 * as they are or is refused. */
export const EMBEDDED_FIELDS = ['captureTime', 'camera', 'lens', 'location'] as const satisfies readonly DisclosureField[];

const RANK: Readonly<Record<DisclosureClass, number>> = { private: 0, shared: 1, public: 2 };

export function isWiderThan(a: DisclosureClass, b: DisclosureClass): boolean {
  return RANK[a] > RANK[b];
}

/** A collection- or photo-scope override. `widened` records that this level
 * widened by an explicit action; without it a wider class is ignored. */
export const disclosureOverrideSchema = z
  .object({ field: disclosureFieldSchema, class: disclosureClassSchema, widened: z.boolean() })
  .strict();
export type DisclosureOverride = z.output<typeof disclosureOverrideSchema>;

export const DISCLOSURE_OVERRIDE_SCOPES = ['collection', 'photo'] as const;
export type DisclosureOverrideScope = (typeof DISCLOSURE_OVERRIDE_SCOPES)[number];
export const disclosureOverrideScopeSchema = z.enum(DISCLOSURE_OVERRIDE_SCOPES);

/** Operation scope: `narrow` withholds for this crossing, `widen` lets a
 * field cross this once — the explicit action §6 requires, recorded by name. */
export const disclosureOperationSchema = z
  .object({
    narrow: z.array(disclosureFieldSchema).max(DISCLOSURE_FIELDS.length),
    widen: z.array(disclosureFieldSchema).max(DISCLOSURE_FIELDS.length),
  })
  .strict();
export type DisclosureOperation = z.output<typeof disclosureOperationSchema>;
export const EMPTY_DISCLOSURE_OPERATION: DisclosureOperation = { narrow: [], widen: [] };

export interface DisclosureChain {
  readonly library: DisclosurePolicy;
  /** Overrides of every collection the photo belongs to, narrowest wins. */
  readonly collections?: readonly (readonly DisclosureOverride[])[] | undefined;
  readonly photo?: readonly DisclosureOverride[] | undefined;
}

function applyLevel(current: DisclosureClass, overrides: readonly DisclosureOverride[], field: DisclosureField): DisclosureClass {
  const override = overrides.find((entry) => entry.field === field);
  if (override === undefined) return current;
  return !isWiderThan(override.class, current) || override.widened ? override.class : current;
}

/** §6 scope resolution: library → collection → photo. Narrowing applies at
 * any level; widening only where that level recorded an explicit action,
 * and it is never inherited downward as a silent default. Several
 * collections resolve to the narrowest of them. */
export function resolveFieldClass(field: DisclosureField, chain: DisclosureChain): DisclosureClass {
  let current = chain.library.fields[field];
  const collections = chain.collections ?? [];
  if (collections.length > 0) {
    current = collections
      .map((overrides) => applyLevel(current, overrides, field))
      .reduce((narrowest, candidate) => (isWiderThan(candidate, narrowest) ? narrowest : candidate));
  }
  return applyLevel(current, chain.photo ?? [], field);
}

export type DisclosureReason = 'class' | 'narrowed' | 'widened';

export interface DisclosureDecision {
  readonly field: DisclosureField;
  /** The resolved class before the operation. */
  readonly class: DisclosureClass;
  readonly disclosed: boolean;
  readonly reason: DisclosureReason;
}

export interface DisclosurePlan {
  readonly boundary: DisclosureBoundary;
  readonly destination: DisclosureDestination;
  readonly policyVersion: number;
  readonly decisions: readonly DisclosureDecision[];
  readonly disclosed: readonly DisclosureField[];
  readonly withheld: readonly DisclosureField[];
  readonly widened: readonly DisclosureField[];
}

/** The exact field set for one crossing. A field crosses when its resolved
 * class is at least the destination's, unless the operation narrows it; a
 * narrower field crosses only when the operation widens it explicitly. */
export function compileDisclosurePlan(input: {
  readonly boundary: DisclosureBoundary;
  readonly destination: DisclosureDestination;
  readonly chain: DisclosureChain;
  readonly operation?: DisclosureOperation | undefined;
}): DisclosurePlan {
  const operation = input.operation ?? EMPTY_DISCLOSURE_OPERATION;
  const decisions = BOUNDARY_FIELDS[input.boundary].map((field): DisclosureDecision => {
    const resolved = resolveFieldClass(field, input.chain);
    if (operation.narrow.includes(field)) return { field, class: resolved, disclosed: false, reason: 'narrowed' };
    if (RANK[resolved] >= RANK[input.destination]) return { field, class: resolved, disclosed: true, reason: 'class' };
    if (operation.widen.includes(field)) return { field, class: resolved, disclosed: true, reason: 'widened' };
    return { field, class: resolved, disclosed: false, reason: 'class' };
  });
  return {
    boundary: input.boundary,
    destination: input.destination,
    policyVersion: input.chain.library.version,
    decisions,
    disclosed: decisions.filter((decision) => decision.disclosed).map((decision) => decision.field),
    withheld: decisions.filter((decision) => !decision.disclosed).map((decision) => decision.field),
    widened: decisions.filter((decision) => decision.reason === 'widened').map((decision) => decision.field),
  };
}

/** A plan that discloses everything the boundary carries — the posture of a
 * caller with no policy (unit worlds); production always compiles one. */
export function permissivePlan(boundary: DisclosureBoundary, destination: DisclosureDestination = 'shared'): DisclosurePlan {
  const decisions = BOUNDARY_FIELDS[boundary].map((field): DisclosureDecision => ({
    field,
    class: 'public',
    disclosed: true,
    reason: 'class',
  }));
  return {
    boundary,
    destination,
    policyVersion: DISCLOSURE_POLICY_VERSION,
    decisions,
    disclosed: decisions.map((decision) => decision.field),
    withheld: [],
    widened: [],
  };
}

export function discloses(plan: DisclosurePlan, field: DisclosureField): boolean {
  return plan.disclosed.includes(field);
}
