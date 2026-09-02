import { parentPort } from 'node:worker_threads';

import sharp from 'sharp';

import { binHistogram, type HistogramData } from '../../shared/library/histogram.js';

// Histogram worker (#498): decode a mid derivative to raw samples and bin
// them, off the main thread. The bytes arrive already decrypted (BlobStore
// decrypts in main) as this thread's own structured-clone copy, so both the
// encoded copy and the decoded samples are wiped here once binned, on
// success and on failure alike; nothing touches disk.

export interface HistogramJobRequest {
  readonly jobId: number;
  /** Decodable derivative bytes (WebP per ADR-0006). */
  readonly bytes: Uint8Array;
}

export interface HistogramJobResponse {
  readonly jobId: number;
  readonly ok: boolean;
  readonly histogram?: HistogramData;
  readonly error?: string;
}

async function histogramOf(bytes: Uint8Array): Promise<HistogramData> {
  const { data, info } = await sharp(bytes, { failOn: 'error' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  try {
    return binHistogram(data, info.width, info.height, info.channels);
  } finally {
    data.fill(0);
  }
}

parentPort?.on('message', (request: HistogramJobRequest) => {
  void histogramOf(request.bytes)
    .then((histogram) => {
      parentPort?.postMessage({ jobId: request.jobId, ok: true, histogram } satisfies HistogramJobResponse);
    })
    .catch((error: unknown) => {
      // Undecodable bytes are an expected outcome (a corrupt derivative is
      // reported, never fabricated) — ok:false, not a worker death.
      parentPort?.postMessage({
        jobId: request.jobId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies HistogramJobResponse);
    })
    .finally(() => {
      request.bytes.fill(0);
    });
});
