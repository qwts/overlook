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

/**
 * Every candidate pair at or under `threshold`, merged into connected groups.
 * O(n²) over the fresh entries — a library of ten thousand photos is fifty
 * million 64-bit comparisons, well under a second, and the answer is cached
 * by the service until the index or the classification changes.
 */
export function findDuplicateGroups(entries: readonly FingerprintEntry[], threshold = DUPLICATE_DISTANCE_THRESHOLD): DuplicateGroup[] {
  const sorted = [...entries].sort((left, right) => (left.photoId < right.photoId ? -1 : left.photoId > right.photoId ? 1 : 0));
  const pairs: DuplicatePair[] = [];
  const sets = new DisjointSet();
  for (let index = 0; index < sorted.length; index += 1) {
    const left = sorted[index];
    if (left === undefined) continue;
    for (let other = index + 1; other < sorted.length; other += 1) {
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

/** The strongest evidence tying one photo to the rest of its group. */
export function closestPairFor(group: DuplicateGroup, photoId: string): DuplicatePair | null {
  let best: DuplicatePair | null = null;
  for (const pair of group.pairs) {
    if (pair.left !== photoId && pair.right !== photoId) continue;
    if (best === null || pair.distance < best.distance) best = pair;
  }
  return best;
}
