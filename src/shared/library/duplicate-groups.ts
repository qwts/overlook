import { duplicatePairEligible } from './duplicate-policy.js';
import { closestRotation, type Fingerprint, type FingerprintRotation } from './perceptual-hash.js';

// Perceptual duplicate candidates (#650): pure grouping over fresh
// fingerprints. Nothing here is persisted — pairs are derived on demand so a
// classification change (#482) or a trashed row can never leave a stale pair
// on screen. Intentional variants (#496, ADR-0031 §3) share one content hash
// or reference each other through `variant_source_id`; they are one asset by
// design and never a candidate pair.

/** Hamming bits (of 64) at or below which two photos are a candidate pair. */
export const DUPLICATE_DISTANCE_THRESHOLD = 10;

export interface FingerprintEntry {
  readonly photoId: string;
  readonly contentHash: string;
  readonly variantSourceId: string | null;
  readonly isOriginal: boolean;
  /** Upright, 90°, 180°, 270° — the stored rotation set. */
  readonly rotations: readonly Fingerprint[];
}

export interface DuplicatePair {
  readonly left: string;
  readonly right: string;
  readonly distance: number;
  readonly rotation: FingerprintRotation;
}

export interface DuplicateGroup {
  /** Stable across recomputation: the smallest photo id in the group. */
  readonly id: string;
  readonly photoIds: readonly string[];
  readonly pairs: readonly DuplicatePair[];
}

/** Why two rows can never be a candidate pair, independent of similarity. */
export function intentionalVariants(left: FingerprintEntry, right: FingerprintEntry): boolean {
  return left.contentHash === right.contentHash || left.variantSourceId === right.photoId || right.variantSourceId === left.photoId;
}

function candidatePair(left: FingerprintEntry, right: FingerprintEntry, threshold: number): DuplicatePair | null {
  if (intentionalVariants(left, right) || !duplicatePairEligible(left, right)) return null;
  const upright = left.rotations[0];
  if (upright === undefined) return null;
  const match = closestRotation(upright, right.rotations);
  if (match.distance > threshold) return null;
  return { left: left.photoId, right: right.photoId, distance: match.distance, rotation: match.rotation };
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== undefined && this.parent.get(root) !== root) root = this.parent.get(root) ?? root;
    let cursor = id;
    while (cursor !== root) {
      const next = this.parent.get(cursor) ?? root;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    // The smaller id becomes the root so group ids are deterministic.
    if (leftRoot < rightRoot) this.parent.set(rightRoot, leftRoot);
    else this.parent.set(leftRoot, rightRoot);
  }
}

/** The 64-bit fingerprint split into eight 8-bit bands (one hex pair each). */
const BANDS = 8;
const BAND_VALUES = 256;

function band(hash: Fingerprint, index: number): number {
  return Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16);
}

/** Every byte within `radius` flipped bits of `value`, `value` first. */
function bandNeighbours(value: number, radius: number): number[] {
  const out = [value];
  const walk = (from: number, remaining: number, current: number): void => {
    if (remaining === 0) return;
    for (let bit = from; bit < 8; bit += 1) {
      const flipped = current ^ (1 << bit);
      out.push(flipped);
      walk(bit + 1, remaining - 1, flipped);
    }
  };
  walk(0, Math.min(radius, 8), value);
  return out;
}

/**
 * Multi-index hashing over the rotation sets: each stored hash is filed under
 * its eight bands, and a query hash within `threshold` bits of it must agree
 * with at least one band to within ⌊threshold / 8⌋ bits (pigeonhole), so the
 * candidates read back from those band buckets are a superset of every pair
 * the exhaustive scan would find — the exact check still decides.
 */
class BandIndex {
  private readonly buckets = new Map<number, number[]>();
  private readonly radius: number;

  constructor(threshold: number) {
    this.radius = Math.floor(threshold / BANDS);
  }

  /** Files entry `position`'s rotation `turn` hash. */
  add(hash: Fingerprint, position: number, turn: number): void {
    for (let index = 0; index < BANDS; index += 1) {
      const key = index * BAND_VALUES + band(hash, index);
      const bucket = this.buckets.get(key);
      const packed = position * 4 + turn;
      if (bucket === undefined) this.buckets.set(key, [packed]);
      else bucket.push(packed);
    }
  }

  /** Entry positions after `position` whose rotation set may be within the threshold of `hash`. */
  candidates(hash: Fingerprint, position: number, seen: Int32Array, stamp: number): number[] {
    const found: number[] = [];
    for (let index = 0; index < BANDS; index += 1) {
      for (const value of bandNeighbours(band(hash, index), this.radius)) {
        const bucket = this.buckets.get(index * BAND_VALUES + value);
        if (bucket === undefined) continue;
        for (const packed of bucket) {
          const other = Math.floor(packed / 4);
          if (other <= position || seen[other] === stamp) continue;
          seen[other] = stamp;
          found.push(other);
        }
      }
    }
    return found.sort((left, right) => left - right);
  }
}

/**
 * Every candidate pair at or under `threshold`, merged into connected groups.
 * Candidates come from the band index, so the work grows with the number of
 * near matches rather than with n² — a library of ten thousand photos is a
 * few hundred thousand bucket reads on the main thread, not fifty million
 * comparisons — and the answer is the same as an exhaustive scan. The service
 * caches it until the index or the classification changes.
 */
export function findDuplicateGroups(entries: readonly FingerprintEntry[], threshold = DUPLICATE_DISTANCE_THRESHOLD): DuplicateGroup[] {
  const sorted = [...entries].sort((left, right) => (left.photoId < right.photoId ? -1 : left.photoId > right.photoId ? 1 : 0));
  const pairs: DuplicatePair[] = [];
  const sets = new DisjointSet();
  const index = new BandIndex(threshold);
  for (let position = 0; position < sorted.length; position += 1) {
    const entry = sorted[position];
    if (entry === undefined || entry.rotations[0] === undefined) continue;
    entry.rotations.forEach((hash, turn) => {
      index.add(hash, position, turn);
    });
  }
  const seen = new Int32Array(sorted.length);
  for (let position = 0; position < sorted.length; position += 1) {
    const left = sorted[position];
    const upright = left?.rotations[0];
    if (left === undefined || upright === undefined) continue;
    for (const other of index.candidates(upright, position, seen, position + 1)) {
      const right = sorted[other];
      if (right === undefined) continue;
      const pair = candidatePair(left, right, threshold);
      if (pair === null) continue;
      pairs.push(pair);
      sets.union(pair.left, pair.right);
    }
  }
  const members = new Map<string, { photoIds: string[]; pairs: DuplicatePair[] }>();
  for (const pair of pairs) {
    const root = sets.find(pair.left);
    const group = members.get(root) ?? { photoIds: [], pairs: [] };
    group.pairs.push(pair);
    members.set(root, group);
  }
  for (const entry of sorted) {
    const group = members.get(sets.find(entry.photoId));
    if (group !== undefined) group.photoIds.push(entry.photoId);
  }
  return [...members.entries()]
    .map(([id, group]) => ({
      id,
      photoIds: group.photoIds,
      pairs: [...group.pairs].sort((left, right) => left.distance - right.distance || (left.left < right.left ? -1 : 1)),
    }))
    .sort((left, right) => right.photoIds.length - left.photoIds.length || (left.id < right.id ? -1 : 1));
}

/**
 * How far `photoId` is turned relative to the other member of `pair`. The
 * pair's rotation describes `right` relative to `left`, so the left member
 * reads the inverse turn.
 */
export function rotationOf(pair: DuplicatePair, photoId: string): FingerprintRotation {
  if (photoId === pair.right) return pair.rotation;
  const inverse = (360 - pair.rotation) % 360;
  return inverse === 90 || inverse === 180 || inverse === 270 ? inverse : 0;
}

/** The strongest evidence tying one photo to the rest of its group. */
export function closestPairFor(group: DuplicateGroup, photoId: string): DuplicatePair | null {
  let best: DuplicatePair | null = null;
  for (const pair of group.pairs) {
    if (pair.left !== photoId && pair.right !== photoId) continue;
    if (best === null || pair.distance < best.distance) best = pair;
  }
  return best;
}
