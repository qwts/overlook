// Perceptual fingerprint (#650): a 64-bit difference hash over a 9×8
// greyscale downscale of the photo's own mid derivative. Pure and
// process-free — the resize happens in main (sharp), this module only bins
// the 72 samples and compares fingerprints. Versioned so a change to the
// sample geometry or the bit order requeues every photo rather than mixing
// incomparable hashes.

export const FINGERPRINT_VERSION = 'dhash-9x8-v1';

/** Grey samples per fingerprint: one extra column so each row yields 8 bits. */
export const FINGERPRINT_SAMPLE_WIDTH = 9;
export const FINGERPRINT_SAMPLE_HEIGHT = 8;
export const FINGERPRINT_BITS = FINGERPRINT_SAMPLE_HEIGHT * (FINGERPRINT_SAMPLE_WIDTH - 1);

/** The rotations fingerprinted for every photo, in stored order. */
export const FINGERPRINT_ROTATIONS = [0, 90, 180, 270] as const;
export type FingerprintRotation = (typeof FINGERPRINT_ROTATIONS)[number];

/** Sixteen lowercase hex digits: 64 bits, row-major, most significant first. */
export type Fingerprint = string;

const HEX = /^[0-9a-f]{16}$/u;

export function isFingerprint(value: string): value is Fingerprint {
  return HEX.test(value);
}

/**
 * Difference hash: bit (row, column) is set when the sample is brighter than
 * its right-hand neighbour. Brightness gradients survive recompression,
 * resizing and mild colour shifts; the hash is not rotation-invariant, which
 * is why callers fingerprint each rotation separately.
 */
export function differenceHash(samples: Uint8Array): Fingerprint {
  const expected = FINGERPRINT_SAMPLE_WIDTH * FINGERPRINT_SAMPLE_HEIGHT;
  if (samples.length !== expected) {
    throw new RangeError(`difference hash expects ${String(expected)} grey samples, got ${String(samples.length)}`);
  }
  let hash = '';
  for (let row = 0; row < FINGERPRINT_SAMPLE_HEIGHT; row += 1) {
    let byte = 0;
    for (let column = 0; column < FINGERPRINT_SAMPLE_WIDTH - 1; column += 1) {
      const index = row * FINGERPRINT_SAMPLE_WIDTH + column;
      const left = samples[index] ?? 0;
      const right = samples[index + 1] ?? 0;
      byte = (byte << 1) | (left > right ? 1 : 0);
    }
    hash += byte.toString(16).padStart(2, '0');
  }
  return hash;
}

const NIBBLE_POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4] as const;

/** Bits that differ between two fingerprints (0..64). */
export function hammingDistance(left: Fingerprint, right: Fingerprint): number {
  if (!isFingerprint(left) || !isFingerprint(right)) throw new RangeError('hamming distance expects two 16-digit hex fingerprints');
  let distance = 0;
  for (let index = 0; index < 16; index += 1) {
    const xor = Number.parseInt(left[index] ?? '0', 16) ^ Number.parseInt(right[index] ?? '0', 16);
    distance += NIBBLE_POPCOUNT[xor] ?? 0;
  }
  return distance;
}

export interface RotationMatch {
  readonly distance: number;
  /** How far `right` is turned relative to `left` for the closest match. */
  readonly rotation: FingerprintRotation;
}

/**
 * The closest match between one photo's upright fingerprint and another's
 * rotation set. Ties resolve to the smaller rotation so the upright match
 * wins whenever it is as good as any turned one.
 */
export function closestRotation(left: Fingerprint, rotations: readonly Fingerprint[]): RotationMatch {
  let best: RotationMatch | null = null;
  FINGERPRINT_ROTATIONS.forEach((rotation, index) => {
    const candidate = rotations[index];
    if (candidate === undefined) return;
    const distance = hammingDistance(left, candidate);
    if (best === null || distance < best.distance) best = { distance, rotation };
  });
  if (best === null) throw new RangeError('a fingerprint rotation set must not be empty');
  return best;
}
