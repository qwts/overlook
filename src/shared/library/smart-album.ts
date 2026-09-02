import { z } from 'zod';

// Smart Albums are versioned predicate documents (#514, ADR-0030 §3). The
// same document drives the live facet filters and a saved Smart Album, and
// one compiler (main/db/predicate-compiler.ts) turns it into SQL, so a saved
// query can never diverge from the equivalent live filter. Values inside a
// facet group are an inclusive union (OR); groups compose by an explicit,
// user-chosen AND / OR — the boolean semantics are never hidden.
//
// Unknown versions and unknown facets fail closed: `parseSmartPredicate`
// reports what it could not understand and the caller preserves the raw
// document unchanged. A predicate is never partially evaluated.

export const SMART_PREDICATE_VERSION = 1;

export const FACET_IDS = ['fileType', 'megapixels', 'camera', 'lens', 'location', 'tag', 'favorite', 'custody', 'availability'] as const;
export type FacetId = (typeof FACET_IDS)[number];
/** Facets whose values the library enumerates for the picker. */
export const ENUMERATED_FACETS = ['fileType', 'camera', 'lens', 'location', 'tag'] as const;
export type EnumeratedFacet = (typeof ENUMERATED_FACETS)[number];

export type FacetComposition = 'and' | 'or';

export const FILE_KINDS: readonly string[] = ['jpeg', 'raw', 'png', 'heic', 'gif', 'webp', 'video', 'audio', 'other'];
export const SYNC_STATUSES: readonly string[] = ['local', 'syncing', 'synced', 'offloaded', 'error'];
export const FAVORITE_VALUES = ['yes', 'no'] as const;
export const AVAILABILITY_VALUES = ['available', 'unavailable'] as const;

export interface MegapixelRange {
  readonly min: number | null;
  readonly max: number | null;
}

export interface ValueFacetGroup {
  readonly facet: Exclude<FacetId, 'megapixels'>;
  /** Non-empty; any value matches (inclusive union). */
  readonly values: readonly string[];
}

export interface MegapixelFacetGroup {
  readonly facet: 'megapixels';
  /** Non-empty; any range matches. Unknown dimensions never match a range. */
  readonly ranges: readonly MegapixelRange[];
}

export type FacetGroup = ValueFacetGroup | MegapixelFacetGroup;

export interface SmartPredicate {
  readonly version: typeof SMART_PREDICATE_VERSION;
  readonly composition: FacetComposition;
  readonly groups: readonly FacetGroup[];
  /** Saved sort order; absent = the library's current sort. */
  readonly order?: 'date' | 'name' | 'size' | undefined;
}

const facetValue = z.string().min(1).max(200);
const valuesOf = (values: readonly string[]) =>
  z
    .array(z.enum(values as [string, ...string[]]))
    .min(1)
    .max(50)
    .readonly();

const megapixelRangeSchema = z
  .strictObject({ min: z.number().nonnegative().nullable(), max: z.number().nonnegative().nullable() })
  .refine((range) => range.min !== null || range.max !== null, 'a range needs a bound')
  .refine((range) => range.min === null || range.max === null || range.min <= range.max, 'min exceeds max');

export const facetGroupSchema = z.discriminatedUnion('facet', [
  z.strictObject({ facet: z.literal('fileType'), values: valuesOf(FILE_KINDS) }),
  z.strictObject({ facet: z.literal('camera'), values: z.array(facetValue).min(1).max(50).readonly() }),
  z.strictObject({ facet: z.literal('lens'), values: z.array(facetValue).min(1).max(50).readonly() }),
  z.strictObject({ facet: z.literal('location'), values: z.array(facetValue).min(1).max(50).readonly() }),
  z.strictObject({ facet: z.literal('tag'), values: z.array(facetValue).min(1).max(50).readonly() }),
  z.strictObject({ facet: z.literal('favorite'), values: valuesOf(FAVORITE_VALUES) }),
  z.strictObject({ facet: z.literal('custody'), values: valuesOf(SYNC_STATUSES) }),
  z.strictObject({ facet: z.literal('availability'), values: valuesOf(AVAILABILITY_VALUES) }),
  z.strictObject({ facet: z.literal('megapixels'), ranges: z.array(megapixelRangeSchema).min(1).max(10).readonly() }),
]);

export const smartPredicateSchema = z.strictObject({
  version: z.literal(SMART_PREDICATE_VERSION),
  composition: z.enum(['and', 'or']),
  groups: z
    .array(facetGroupSchema)
    .max(20)
    .readonly()
    .refine((groups) => new Set(groups.map((group) => group.facet)).size === groups.length, 'each facet appears at most once'),
  order: z.enum(['date', 'name', 'size']).optional(),
});

export const EMPTY_PREDICATE: SmartPredicate = { version: SMART_PREDICATE_VERSION, composition: 'and', groups: [] };

export type SmartPredicateParse =
  { readonly ok: true; readonly predicate: SmartPredicate } | { readonly ok: false; readonly reason: string };

/** Fails closed (ADR-0030 §3): a document this reader cannot fully evaluate
 * is reported with the specific thing it could not understand, and the
 * caller keeps the document unchanged rather than dropping a clause. */
export function parseSmartPredicate(raw: unknown): SmartPredicateParse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false, reason: 'the saved query is not a predicate document' };
  const version = (raw as { version?: unknown }).version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: 'the saved query has no predicate version' };
  }
  if (version > SMART_PREDICATE_VERSION)
    return { ok: false, reason: `predicate version ${String(version)} is newer than this app understands` };
  const groups = (raw as { groups?: unknown }).groups;
  if (Array.isArray(groups)) {
    for (const group of groups as readonly unknown[]) {
      const facet = typeof group === 'object' && group !== null ? (group as { facet?: unknown }).facet : undefined;
      if (typeof facet === 'string' && !(FACET_IDS as readonly string[]).includes(facet)) {
        return { ok: false, reason: `the "${facet}" facet is not one this app can evaluate` };
      }
    }
  }
  const parsed = smartPredicateSchema.safeParse(raw);
  return parsed.success ? { ok: true, predicate: parsed.data } : { ok: false, reason: 'the saved query is malformed' };
}

/** Structural equality without the order (which is view state when live). */
export function predicateEquals(left: SmartPredicate, right: SmartPredicate): boolean {
  return JSON.stringify({ ...left, order: undefined }) === JSON.stringify({ ...right, order: undefined });
}

export function groupFor(predicate: SmartPredicate, facet: FacetId): FacetGroup | undefined {
  return predicate.groups.find((group) => group.facet === facet);
}

function withGroup(predicate: SmartPredicate, facet: FacetId, group: FacetGroup | null): SmartPredicate {
  const rest = predicate.groups.filter((candidate) => candidate.facet !== facet);
  const groups = group === null ? rest : [...rest, group].sort((a, b) => FACET_IDS.indexOf(a.facet) - FACET_IDS.indexOf(b.facet));
  return { ...predicate, groups };
}

/** One facet value chosen in the picker. A plain choice makes the value the
 * group's only member (choosing it again clears the group); an additive
 * choice — Shift-click, or the picker's combine mode — toggles it within
 * the inclusive union (#514). */
export function toggleFacetValue(
  predicate: SmartPredicate,
  facet: Exclude<FacetId, 'megapixels'>,
  value: string,
  additive: boolean,
): SmartPredicate {
  const current = groupFor(predicate, facet);
  const values = current !== undefined && current.facet !== 'megapixels' ? current.values : [];
  if (!additive) return withGroup(predicate, facet, values.length === 1 && values[0] === value ? null : { facet, values: [value] });
  const next = values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value];
  return withGroup(predicate, facet, next.length === 0 ? null : { facet, values: next });
}

export function setMegapixelRanges(predicate: SmartPredicate, ranges: readonly MegapixelRange[]): SmartPredicate {
  return withGroup(predicate, 'megapixels', ranges.length === 0 ? null : { facet: 'megapixels', ranges });
}

export function clearFacet(predicate: SmartPredicate, facet?: FacetId): SmartPredicate {
  return facet === undefined ? { ...predicate, groups: [] } : withGroup(predicate, facet, null);
}

export function setComposition(predicate: SmartPredicate, composition: FacetComposition): SmartPredicate {
  return { ...predicate, composition };
}
