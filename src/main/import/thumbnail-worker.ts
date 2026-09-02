import { parentPort } from 'node:worker_threads';

import sharp from 'sharp';

import { bakeTransform, decodable, type DecodableInput } from './bake-transform.js';
import { displayDimensions } from './display-dimensions.js';
import { isIdentityTransform, type EditTransform } from '../../shared/library/edit-revision.js';

// Thumbnail worker (#86): decode → resize → WebP per ADR-0006, off the main
// thread. Derivatives are sRGB and metadata-free — a thumbnail must never
// leak the GPS track the original carries. Encryption happens back in main
// (BlobStore.putThumb encrypts before anything touches disk).

export interface ThumbJobRequest {
  readonly jobId: number;
  /** Decodable image bytes (RAW callers resolve embedded/native previews first). */
  readonly bytes: Uint8Array;
  /** Persisted edits to bake into the derivatives (#493, ADR-0031 §2):
   * EXIF orientation first, then rotate/flip, then the crop in oriented
   * space. Absent or identity = the untouched pipeline. */
  readonly transform?: EditTransform | undefined;
}

export interface ThumbJobResponse {
  readonly jobId: number;
  readonly ok: boolean;
  readonly thumb?: Uint8Array;
  readonly mid?: Uint8Array;
  readonly width?: number;
  readonly height?: number;
  readonly error?: string;
}

// ADR-0006 derivative spec.
const THUMB_EDGE = 512;
const THUMB_QUALITY = 80;
const MID_EDGE = 2048;
const MID_QUALITY = 85;

async function derivative(input: DecodableInput, edge: number, quality: number): Promise<Buffer> {
  // sharp strips metadata and resolves to sRGB by default (no withMetadata /
  // withIccProfile) — exactly the ADR's privacy stance; rotate() bakes the
  // EXIF orientation in before the tag is dropped.
  return decodable(input).rotate().resize(edge, edge, { fit: 'inside', withoutEnlargement: true }).webp({ quality }).toBuffer();
}

async function makeDerivatives(bytes: Uint8Array, transform?: EditTransform): Promise<Omit<ThumbJobResponse, 'jobId' | 'ok' | 'error'>> {
  const meta = await sharp(bytes, { failOn: 'error' }).metadata();
  const dimensions = displayDimensions(meta.width, meta.height, meta.orientation);
  if (dimensions === null) throw new Error('decoded image has invalid dimensions');
  const input =
    transform === undefined || isIdentityTransform(transform)
      ? { bytes }
      : await bakeTransform(bytes, transform, dimensions.width, dimensions.height);
  const thumb = await derivative(input, THUMB_EDGE, THUMB_QUALITY);
  const mid = await derivative(input, MID_EDGE, MID_QUALITY);
  return { thumb, mid, ...dimensions };
}

parentPort?.on('message', (request: ThumbJobRequest) => {
  void makeDerivatives(request.bytes, request.transform)
    .then((result) => {
      parentPort?.postMessage({ jobId: request.jobId, ok: true, ...result } satisfies ThumbJobResponse);
    })
    .catch((error: unknown) => {
      // Undecodable/unsupported bytes are an EXPECTED outcome (placeholder
      // contract, E5.3) — reported as ok:false, never a worker death.
      parentPort?.postMessage({
        jobId: request.jobId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies ThumbJobResponse);
    });
});
