import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import sharp from 'sharp';

import { fingerprintImage, FingerprintDecodeError } from '../../src/main/library/perceptual-fingerprint.js';
import {
  DUPLICATE_DISTANCE_THRESHOLD,
  closestPairFor,
  findDuplicateGroups,
  intentionalVariants,
  rotationOf,
  type DuplicatePair,
  type FingerprintEntry,
} from '../../src/shared/library/duplicate-groups.js';
import {
  FINGERPRINT_ROTATIONS,
  closestRotation,
  differenceHash,
  hammingDistance,
  isFingerprint,
} from '../../src/shared/library/perceptual-hash.js';

// #650: the fingerprint is a pure difference hash over 9×8 grey samples, the
// grouping is pure over entries, and the fixture-backed matrix proves the
// documented candidate cases — exact, recompressed, resized, rotated and
// unrelated — plus the #482 policy and the #496 variant exclusion.

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'photos');

function entry(photoId: string, rotations: readonly string[], overrides: Partial<FingerprintEntry> = {}): FingerprintEntry {
  return { photoId, contentHash: `hash-${photoId}`, variantSourceId: null, isOriginal: false, rotations, ...overrides };
}

const ZERO = '0'.repeat(16);
const ONE_BIT = '0'.repeat(15) + '1';
const FAR = 'f'.repeat(16);

describe('difference hash (#650)', () => {
  test('bins 72 grey samples into 64 bits, one per left-brighter-than-right comparison', () => {
    const samples = new Uint8Array(72);
    // Row 0: strictly decreasing → every comparison sets its bit (0xff).
    for (let column = 0; column < 9; column += 1) samples[column] = 9 - column;
    // Row 1: strictly increasing → no bit set.
    for (let column = 0; column < 9; column += 1) samples[9 + column] = column;
    const hash = differenceHash(samples);
    assert.ok(isFingerprint(hash));
    assert.equal(hash.slice(0, 4), 'ff00');
    assert.throws(() => differenceHash(new Uint8Array(71)), RangeError);
  });

  test('hamming distance counts differing bits and refuses malformed input', () => {
    assert.equal(hammingDistance(ZERO, ZERO), 0);
    assert.equal(hammingDistance(ZERO, ONE_BIT), 1);
    assert.equal(hammingDistance(ZERO, FAR), 64);
    assert.throws(() => hammingDistance('nope', ZERO), RangeError);
  });

  test('the closest rotation wins, ties go to the smaller turn', () => {
    assert.deepEqual(closestRotation(ZERO, [FAR, ONE_BIT, ZERO, ZERO]), { distance: 0, rotation: 180 });
    assert.deepEqual(closestRotation(ZERO, [ZERO, ZERO, ZERO, ZERO]), { distance: 0, rotation: 0 });
    assert.throws(() => closestRotation(ZERO, []), RangeError);
  });
});

describe('duplicate grouping (#650)', () => {
  test('pairs at or under the threshold merge into groups keyed by the smallest id; unrelated photos stay out', () => {
    const groups = findDuplicateGroups([
      entry('c', [ONE_BIT, FAR, FAR, FAR]),
      entry('a', [ZERO, FAR, FAR, FAR]),
      entry('b', ['0'.repeat(14) + '03', FAR, FAR, FAR]),
      entry('z', [FAR, FAR, FAR, FAR]),
    ]);
    assert.equal(groups.length, 1);
    const group = groups[0];
    assert.ok(group !== undefined);
    assert.equal(group.id, 'a');
    assert.deepEqual(group.photoIds, ['a', 'b', 'c']);
    assert.deepEqual(group.pairs[0], { left: 'a', right: 'c', distance: 1, rotation: 0 });
    assert.equal(closestPairFor(group, 'b')?.distance, 1);
    assert.equal(closestPairFor(group, 'z'), null);
  });

  test('a rotated copy matches through its rotation set and reports the turn', () => {
    const upright = 'a5a5a5a5a5a5a5a5';
    const groups = findDuplicateGroups([entry('p', [upright, FAR, FAR, FAR]), entry('q', [FAR, FAR, FAR, upright])]);
    assert.deepEqual(groups[0]?.pairs, [{ left: 'p', right: 'q', distance: 0, rotation: 270 }]);
  });

  test('the #482 policy applies at grouping time: an Original never pairs with a non-Original', () => {
    const same = [ZERO, ZERO, ZERO, ZERO];
    assert.equal(findDuplicateGroups([entry('a', same, { isOriginal: true }), entry('b', same)]).length, 0);
    assert.equal(findDuplicateGroups([entry('a', same, { isOriginal: true }), entry('b', same, { isOriginal: true })]).length, 1);
    assert.equal(findDuplicateGroups([entry('a', same), entry('b', same)]).length, 1);
  });

  test('intentional variants (#496) are one asset, never a candidate pair', () => {
    const same = [ZERO, ZERO, ZERO, ZERO];
    const root = entry('root', same, { contentHash: 'shared' });
    const sibling = entry('sib', same, { contentHash: 'shared', variantSourceId: 'root' });
    const derived = entry('edit', same, { contentHash: 'other', variantSourceId: 'root' });
    assert.ok(intentionalVariants(root, sibling));
    assert.ok(intentionalVariants(root, derived));
    assert.ok(intentionalVariants(derived, root));
    assert.equal(findDuplicateGroups([root, sibling]).length, 0);
    assert.equal(findDuplicateGroups([root, derived]).length, 0);
    // A third, unrelated import of the same picture still surfaces against both.
    const copy = entry('copy', same);
    assert.deepEqual(findDuplicateGroups([root, sibling, copy])[0]?.photoIds, ['copy', 'root', 'sib']);
  });

  test('a member reads the turn relative to its closest match, so the left member reads the inverse', () => {
    const pair: DuplicatePair = { left: 'a', right: 'b', distance: 3, rotation: 90 };
    assert.equal(rotationOf(pair, 'b'), 90);
    assert.equal(rotationOf(pair, 'a'), 270);
    assert.equal(rotationOf({ ...pair, rotation: 180 }, 'a'), 180);
    assert.equal(rotationOf({ ...pair, rotation: 0 }, 'a'), 0);
  });

  test('the band index finds exactly the pairs an exhaustive scan finds, at every threshold', () => {
    // Deterministic pseudo-random hashes with planted near-duplicates at,
    // just under and just over the threshold, some only through a rotation.
    let seed = 0x650;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    const randomHash = (): string => Array.from({ length: 16 }, () => Math.floor(random() * 16).toString(16)).join('');
    const flip = (hash: string, bits: number): string => {
      const digits = hash.split('');
      const chosen = new Set<number>();
      while (chosen.size < bits) chosen.add(Math.floor(random() * 64));
      for (const bit of chosen) {
        const digit = Math.floor(bit / 4);
        const value = Number.parseInt(digits[digit] ?? '0', 16) ^ (1 << (bit % 4));
        digits[digit] = value.toString(16);
      }
      return digits.join('');
    };
    const entries: FingerprintEntry[] = [];
    for (let index = 0; index < 240; index += 1) {
      const rotations = [randomHash(), randomHash(), randomHash(), randomHash()];
      entries.push(entry(`p${String(index).padStart(3, '0')}`, rotations));
      const planted = index % 6;
      if (planted === 0 || planted === 1 || planted === 2) {
        const turn = planted === 2 ? 3 : 0;
        const bits = planted === 1 ? DUPLICATE_DISTANCE_THRESHOLD + 1 : Math.floor(random() * (DUPLICATE_DISTANCE_THRESHOLD + 1));
        const twin = [randomHash(), randomHash(), randomHash(), randomHash()];
        twin[turn] = flip(rotations[0] ?? ZERO, bits);
        entries.push(entry(`q${String(index).padStart(3, '0')}`, twin));
      }
    }
    const exhaustive = (threshold: number): string[] => {
      const sorted = [...entries].sort((left, right) => (left.photoId < right.photoId ? -1 : 1));
      const pairs: string[] = [];
      for (let index = 0; index < sorted.length; index += 1) {
        for (let other = index + 1; other < sorted.length; other += 1) {
          const left = sorted[index];
          const right = sorted[other];
          if (left?.rotations[0] === undefined || right === undefined) continue;
          const match = closestRotation(left.rotations[0], right.rotations);
          if (match.distance <= threshold)
            pairs.push(`${left.photoId}>${right.photoId}@${String(match.distance)}/${String(match.rotation)}`);
        }
      }
      return pairs.sort();
    };
    for (const threshold of [0, 3, DUPLICATE_DISTANCE_THRESHOLD, 17, 40]) {
      const indexed = findDuplicateGroups(entries, threshold)
        .flatMap((group) => group.pairs)
        .map((pair) => `${pair.left}>${pair.right}@${String(pair.distance)}/${String(pair.rotation)}`)
        .sort();
      assert.deepEqual(indexed, exhaustive(threshold), `threshold ${String(threshold)}`);
      if (threshold === DUPLICATE_DISTANCE_THRESHOLD) assert.ok(indexed.length >= 60, 'the planted pairs were found');
    }
  });

  test('a photo without an upright hash is skipped rather than matched against nothing', () => {
    assert.equal(findDuplicateGroups([entry('a', []), entry('b', [ZERO, ZERO, ZERO, ZERO])]).length, 0);
  });
});

describe('fixture-backed candidate matrix (#650)', () => {
  const original = readFileSync(join(FIXTURES, 'summer-landscape.jpg'));
  const unrelated = readFileSync(join(FIXTURES, 'street-city.jpg'));

  test('exact, recompressed, resized and rotated copies match; an unrelated photo does not', async () => {
    const base = await fingerprintImage(original);
    assert.equal(base.length, FINGERPRINT_ROTATIONS.length);
    assert.ok(base.every((hash) => isFingerprint(hash)));
    const [exact, recompressed, resized, rotated, other] = await Promise.all([
      fingerprintImage(Buffer.from(original)),
      fingerprintImage(await sharp(original).jpeg({ quality: 35 }).toBuffer()),
      fingerprintImage(await sharp(original).resize({ width: 320 }).jpeg({ quality: 80 }).toBuffer()),
      fingerprintImage(await sharp(original).rotate(90).jpeg({ quality: 90 }).toBuffer()),
      fingerprintImage(unrelated),
    ]);
    const upright = base[0];
    assert.ok(upright !== undefined);
    assert.equal(closestRotation(upright, exact).distance, 0, 'an exact copy is bit-identical');
    assert.ok(closestRotation(upright, recompressed).distance <= 2, 'recompression barely moves the gradients');
    assert.ok(closestRotation(upright, resized).distance <= DUPLICATE_DISTANCE_THRESHOLD, 'resizing stays within the threshold');
    const turned = closestRotation(upright, rotated);
    assert.ok(turned.distance <= DUPLICATE_DISTANCE_THRESHOLD, 'a rotated copy matches through its rotation set');
    assert.notEqual(turned.rotation, 0, 'and the turn is reported');
    assert.ok(closestRotation(upright, other).distance > DUPLICATE_DISTANCE_THRESHOLD, 'a different picture is far');

    const groups = findDuplicateGroups([
      entry('orig', base),
      entry('recompressed', recompressed),
      entry('resized', resized),
      entry('rotated', rotated),
      entry('other', other),
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]?.photoIds, ['orig', 'recompressed', 'resized', 'rotated']);
  });

  test('undecodable bytes are refused, not fingerprinted', async () => {
    await assert.rejects(fingerprintImage(Buffer.from('not an image')), FingerprintDecodeError);
  });
});
