import sharp from 'sharp';

import {
  FINGERPRINT_ROTATIONS,
  FINGERPRINT_SAMPLE_HEIGHT,
  FINGERPRINT_SAMPLE_WIDTH,
  differenceHash,
  type Fingerprint,
} from '../../shared/library/perceptual-hash.js';

// Fingerprints one decoded image (#650): sharp downsamples each of the four
// rotations to the 9×8 grey grid (libvips, off the JS thread), the shared
// module bins it. Decrypted bytes stay in memory only for the call; nothing
// is written and no metadata is consulted — the mid derivative is already
// upright and sRGB (ADR-0006), so a stored rotation is the pixel rotation.

export class FingerprintDecodeError extends Error {
  override readonly name = 'FingerprintDecodeError';
}

export async function fingerprintImage(bytes: Buffer, signal?: AbortSignal): Promise<readonly Fingerprint[]> {
  const rotations: Fingerprint[] = [];
  for (const rotation of FINGERPRINT_ROTATIONS) {
    signal?.throwIfAborted();
    let samples: Buffer;
    try {
      samples = await sharp(bytes, { failOn: 'error' })
        .rotate(rotation)
        .greyscale()
        .resize(FINGERPRINT_SAMPLE_WIDTH, FINGERPRINT_SAMPLE_HEIGHT, { fit: 'fill', kernel: 'lanczos3' })
        .raw()
        .toBuffer();
    } catch (error) {
      throw new FingerprintDecodeError(error instanceof Error ? error.message : 'image did not decode');
    }
    rotations.push(differenceHash(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)));
    samples.fill(0);
  }
  return rotations;
}
