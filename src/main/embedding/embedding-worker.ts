import { parentPort, workerData } from 'node:worker_threads';

import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

import { EMBEDDING_DIMENSIONS } from '../db/embedding-repository.js';

export interface EmbeddingWorkerData {
  readonly modelPath: string;
  readonly providers: readonly string[];
}

export interface EmbeddingWorkerRequest {
  readonly jobId: number;
  readonly bytes: Uint8Array;
}

export type EmbeddingWorkerResponse =
  | { readonly jobId: number; readonly ok: true; readonly embedding: Int8Array; readonly provider: string }
  | { readonly jobId: number; readonly ok: false; readonly error: string };

const IMAGE_SIZE = 224;
const MEAN = [0.481_454_66, 0.457_827_5, 0.408_210_73] as const;
const STD = [0.268_629_54, 0.261_302_58, 0.275_777_11] as const;
const options = workerData as EmbeddingWorkerData;

let session: Promise<{ readonly session: ort.InferenceSession; readonly provider: string }> | undefined;

async function createSession(): Promise<{ readonly session: ort.InferenceSession; readonly provider: string }> {
  let lastError: unknown;
  for (const provider of options.providers) {
    try {
      return {
        session: await ort.InferenceSession.create(options.modelPath, { executionProviders: [provider] }),
        provider,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('no ONNX execution provider is available');
}

async function inputTensor(bytes: Uint8Array): Promise<{ readonly tensor: ort.Tensor; readonly pixels: Float32Array }> {
  const { data, info } = await sharp(bytes, { failOn: 'error' })
    .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: 'cover', position: 'centre' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error('embedding input must decode to RGB');
  const pixels = new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE);
  const plane = IMAGE_SIZE * IMAGE_SIZE;
  for (let index = 0; index < plane; index += 1) {
    const source = index * 3;
    pixels[index] = (data[source]! / 255 - MEAN[0]) / STD[0];
    pixels[plane + index] = (data[source + 1]! / 255 - MEAN[1]) / STD[1];
    pixels[plane * 2 + index] = (data[source + 2]! / 255 - MEAN[2]) / STD[2];
  }
  data.fill(0);
  return { tensor: new ort.Tensor('float32', pixels, [1, 3, IMAGE_SIZE, IMAGE_SIZE]), pixels };
}

function quantize(output: ort.Tensor): Int8Array {
  if (!(output.data instanceof Float32Array) || output.data.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`vision model must return ${String(EMBEDDING_DIMENSIONS)} float dimensions`);
  }
  let magnitude = 0;
  for (const value of output.data) magnitude += value * value;
  const scale = magnitude === 0 ? 0 : 127 / Math.sqrt(magnitude);
  const quantized = new Int8Array(EMBEDDING_DIMENSIONS);
  for (let index = 0; index < output.data.length; index += 1) {
    quantized[index] = Math.max(-127, Math.min(127, Math.round(output.data[index]! * scale)));
  }
  output.data.fill(0);
  return quantized;
}

async function embed(bytes: Uint8Array): Promise<{ readonly embedding: Int8Array; readonly provider: string }> {
  session ??= createSession();
  const active = await session;
  const prepared = await inputTensor(bytes);
  try {
    const inputName = active.session.inputNames[0];
    if (inputName === undefined) throw new Error('vision model has no input');
    const outputs = await active.session.run({ [inputName]: prepared.tensor });
    const output = outputs['image_embeds'] ?? outputs[active.session.outputNames[0] ?? ''];
    if (output === undefined) throw new Error('vision model returned no image embedding');
    return { embedding: quantize(output), provider: active.provider };
  } finally {
    prepared.pixels.fill(0);
  }
}

parentPort?.on('message', (request: EmbeddingWorkerRequest) => {
  const bytes = Buffer.from(request.bytes);
  void embed(bytes)
    .then(({ embedding, provider }) => {
      parentPort?.postMessage({
        jobId: request.jobId,
        ok: true,
        embedding,
        provider,
      } satisfies EmbeddingWorkerResponse);
    })
    .catch((error: unknown) => {
      parentPort?.postMessage({
        jobId: request.jobId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies EmbeddingWorkerResponse);
    })
    .finally(() => bytes.fill(0));
});
