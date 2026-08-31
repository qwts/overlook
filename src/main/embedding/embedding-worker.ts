import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';

import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

import { EMBEDDING_DIMENSIONS } from '../db/embedding-repository.js';
import { CLIP_TEXT_LENGTH, createClipTokenizer } from './clip-tokenizer.js';

export interface EmbeddingWorkerData {
  readonly modelPath: string;
  readonly textModelPath?: string;
  readonly tokenizerPath?: string;
  readonly providers: readonly string[];
}

export type EmbeddingWorkerPayload =
  { readonly kind: 'image'; readonly bytes: Uint8Array } | { readonly kind: 'text'; readonly text: string };
export type EmbeddingWorkerRequest = EmbeddingWorkerPayload & { readonly jobId: number };

/** Cooperative shutdown (#843): the worker exits itself once the in-flight
 * job settles. terminate() mid-inference aborts the WHOLE app — onnxruntime's
 * completion callback throws into the torn-down worker env and the C++
 * exception escapes to std::terminate. */
export interface EmbeddingWorkerShutdown {
  readonly shutdown: true;
}

export type EmbeddingWorkerResponse =
  | { readonly jobId: number; readonly ok: true; readonly embedding: Int8Array; readonly provider: string }
  | { readonly jobId: number; readonly ok: false; readonly kind: 'input' | 'runtime'; readonly error: string };

class EmbeddingWorkerInputError extends Error {
  override readonly name = 'EmbeddingWorkerInputError';
}

const IMAGE_SIZE = 224;
const MEAN = [0.481_454_66, 0.457_827_5, 0.408_210_73] as const;
const STD = [0.268_629_54, 0.261_302_58, 0.275_777_11] as const;
const options = workerData as EmbeddingWorkerData;

let visionSession: Promise<{ readonly session: ort.InferenceSession; readonly provider: string }> | undefined;
let textSession: Promise<{ readonly session: ort.InferenceSession; readonly provider: string }> | undefined;
let tokenizer: Promise<(text: string) => readonly number[]> | undefined;

async function createSession(modelPath: string): Promise<{ readonly session: ort.InferenceSession; readonly provider: string }> {
  let lastError: unknown;
  for (const provider of options.providers) {
    try {
      return {
        session: await ort.InferenceSession.create(modelPath, { executionProviders: [provider] }),
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
  visionSession ??= createSession(options.modelPath);
  const active = await visionSession;
  let prepared: Awaited<ReturnType<typeof inputTensor>>;
  try {
    prepared = await inputTensor(bytes);
  } catch (error) {
    throw new EmbeddingWorkerInputError(error instanceof Error ? error.message : 'embedding input could not be decoded');
  }
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

async function embedText(text: string): Promise<{ readonly embedding: Int8Array; readonly provider: string }> {
  if (options.textModelPath === undefined || options.tokenizerPath === undefined) {
    throw new Error('text embedding assets are not configured');
  }
  textSession ??= createSession(options.textModelPath);
  tokenizer ??= readFile(options.tokenizerPath, 'utf8').then((contents) => createClipTokenizer(JSON.parse(contents) as unknown));
  const [active, tokenize] = await Promise.all([textSession, tokenizer]);
  const ids = tokenize(text);
  const inputIds = new BigInt64Array(CLIP_TEXT_LENGTH);
  const attentionMask = new BigInt64Array(CLIP_TEXT_LENGTH);
  for (let index = 0; index < ids.length; index += 1) {
    inputIds[index] = BigInt(ids[index]!);
    attentionMask[index] = 1n;
  }
  const outputs = await active.session.run({
    input_ids: new ort.Tensor('int64', inputIds, [1, CLIP_TEXT_LENGTH]),
    attention_mask: new ort.Tensor('int64', attentionMask, [1, CLIP_TEXT_LENGTH]),
  });
  const output = outputs['text_embeds'] ?? outputs[active.session.outputNames[0] ?? ''];
  if (output === undefined) throw new Error('text model returned no text embedding');
  return { embedding: quantize(output), provider: active.provider };
}

let current: Promise<unknown> = Promise.resolve();

parentPort?.on('message', (request: EmbeddingWorkerRequest | EmbeddingWorkerShutdown) => {
  if ('shutdown' in request) {
    // Value-checked, not just shape-checked: a malformed message carrying a
    // falsy shutdown field is ignored, never an accidental exit.
    if (request.shutdown) {
      void current.then(
        () => process.exit(0),
        () => process.exit(0),
      );
    }
    return;
  }
  const bytes = request.kind === 'text' ? undefined : Buffer.from(request.bytes.buffer, request.bytes.byteOffset, request.bytes.byteLength);
  current = (request.kind === 'text' ? embedText(request.text) : embed(bytes!))
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
        kind: error instanceof EmbeddingWorkerInputError ? 'input' : 'runtime',
        error: error instanceof Error ? error.message : String(error),
      } satisfies EmbeddingWorkerResponse);
    })
    .finally(() => bytes?.fill(0));
});
