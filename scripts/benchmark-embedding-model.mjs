import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pipeline } from 'node:stream/promises';

import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

const ROOT = resolve(import.meta.dirname, '..');
const MANIFEST_PATH = join(ROOT, 'src/main/embedding/model-manifest.json');
const FIXTURES = [
  ['street-square.jpg', join(ROOT, 'tests/fixtures/photos/street-square.jpg')],
  ['flower-landscape.jpg', join(ROOT, 'tests/fixtures/photos/flower-landscape.jpg')],
  ['summer-landscape.jpg', join(ROOT, 'tests/fixtures/photos/summer-landscape.jpg')],
  ['street-city.jpg', join(ROOT, 'tests/fixtures/photos/street-city.jpg')],
];
const LABELED_QUERIES = [
  ['a close-up flower', 'flower-landscape.jpg'],
  ['snowy mountain peaks', 'summer-landscape.jpg'],
  ['a street food cart', 'street-square.jpg'],
  ['a city street', 'street-city.jpg'],
];
const IMAGE_ROUNDS = 5;
const TEXT_ROUNDS = 20;
const TEXT_LENGTH = 77;
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];

function byteEncoder() {
  const bytes = [];
  for (let value = 33; value <= 126; value += 1) bytes.push(value);
  for (let value = 161; value <= 172; value += 1) bytes.push(value);
  for (let value = 174; value <= 255; value += 1) bytes.push(value);
  const unicode = [...bytes];
  let extra = 0;
  for (let value = 0; value < 256; value += 1) {
    if (bytes.includes(value)) continue;
    bytes.push(value);
    unicode.push(256 + extra);
    extra += 1;
  }
  return new Map(bytes.map((value, index) => [value, String.fromCodePoint(unicode[index])]));
}

function pairs(symbols) {
  const result = new Set();
  for (let index = 0; index + 1 < symbols.length; index += 1) {
    result.add(`${symbols[index]}\u0000${symbols[index + 1]}`);
  }
  return result;
}

function mergeToken(token, ranks) {
  if (token.length === 0) return [];
  let symbols = [...token.slice(0, -1), `${token.at(-1)}</w>`];
  while (symbols.length > 1) {
    const candidate = [...pairs(symbols)]
      .map((key) => [key, ranks.get(key)])
      .filter((entry) => entry[1] !== undefined)
      .sort((left, right) => left[1] - right[1])[0];
    if (candidate === undefined) break;
    const [first, second] = candidate[0].split('\u0000');
    const merged = [];
    for (let index = 0; index < symbols.length; index += 1) {
      if (symbols[index] === first && symbols[index + 1] === second) {
        merged.push(`${first}${second}`);
        index += 1;
      } else {
        merged.push(symbols[index]);
      }
    }
    symbols = merged;
  }
  return symbols;
}

function createTokenizer(spec) {
  const encodeByte = byteEncoder();
  const ranks = new Map(spec.model.merges.map((merge, index) => [merge.replace(' ', '\u0000'), index]));
  const pattern = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/gu;
  return (text) => {
    const normalized = text.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();
    const ids = [49406];
    for (const match of normalized.matchAll(pattern)) {
      const encoded = [...new TextEncoder().encode(match[0])].map((value) => encodeByte.get(value)).join('');
      for (const symbol of mergeToken(encoded, ranks)) {
        const id = spec.model.vocab[symbol];
        if (id === undefined) throw new Error(`tokenizer vocabulary misses ${JSON.stringify(symbol)}`);
        ids.push(id);
      }
    }
    ids.push(49407);
    if (ids.length > TEXT_LENGTH) ids.splice(TEXT_LENGTH - 1, ids.length, 49407);
    return ids;
  };
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function valid(path, asset) {
  try {
    const info = await stat(path);
    return info.size === asset.bytes && (await sha256(path)) === asset.sha256;
  } catch {
    return false;
  }
}

async function install(manifest, cacheRoot) {
  const modelDir = join(cacheRoot, manifest.id);
  await mkdir(modelDir, { recursive: true });
  for (const asset of manifest.assets) {
    const destination = join(modelDir, asset.name);
    if (await valid(destination, asset)) continue;
    const partial = `${destination}.part`;
    await rm(partial, { force: true });
    const response = await fetch(asset.url, { redirect: 'follow' });
    if (!response.ok || response.body === null) throw new Error(`download failed for ${asset.name}: ${response.status}`);
    await pipeline(response.body, createWriteStream(partial, { flags: 'wx' }));
    if (!(await valid(partial, asset))) throw new Error(`integrity check failed for ${asset.name}`);
    await rename(partial, destination);
  }
  return modelDir;
}

async function imageTensor(path) {
  const { data, info } = await sharp(path)
    .resize(224, 224, { fit: 'cover', position: 'centre' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`${path} did not decode to RGB`);
  const plane = 224 * 224;
  const pixels = new Float32Array(3 * plane);
  for (let index = 0; index < plane; index += 1) {
    pixels[index] = (data[index * 3] / 255 - MEAN[0]) / STD[0];
    pixels[plane + index] = (data[index * 3 + 1] / 255 - MEAN[1]) / STD[1];
    pixels[plane * 2 + index] = (data[index * 3 + 2] / 255 - MEAN[2]) / STD[2];
  }
  return new ort.Tensor('float32', pixels, [1, 3, 224, 224]);
}

function vector(outputs, preferred) {
  const output = outputs[preferred] ?? outputs[Object.keys(outputs)[0]];
  if (!(output?.data instanceof Float32Array) || output.data.length !== 512) {
    throw new Error(`${preferred} did not return a 512-dimensional float vector`);
  }
  return Float32Array.from(output.data);
}

function cosine(left, right) {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const cacheRoot = resolve(process.env.OVERLOOK_EMBEDDING_MODEL_CACHE ?? join(ROOT, '.embedding-model-cache'));
  const modelDir = await install(manifest, cacheRoot);
  const [vision, text] = await Promise.all([
    ort.InferenceSession.create(join(modelDir, 'vision_model_int8.onnx'), { executionProviders: ['cpu'] }),
    ort.InferenceSession.create(join(modelDir, 'text_model_int8.onnx'), { executionProviders: ['cpu'] }),
  ]);
  const tensors = new Map();
  for (const [name, path] of FIXTURES) tensors.set(name, await imageTensor(path));

  const imageVectors = new Map();
  for (const [name] of FIXTURES) {
    const tensor = tensors.get(name);
    imageVectors.set(name, vector(await vision.run({ [vision.inputNames[0]]: tensor }), 'image_embeds'));
  }
  const imageStarted = performance.now();
  for (let round = 0; round < IMAGE_ROUNDS; round += 1) {
    for (const [name] of FIXTURES) {
      await vision.run({ [vision.inputNames[0]]: tensors.get(name) });
    }
  }
  const imageSeconds = (performance.now() - imageStarted) / 1000;
  const photosPerSecond = (FIXTURES.length * IMAGE_ROUNDS) / imageSeconds;

  const tokenizer = createTokenizer(JSON.parse(await readFile(join(modelDir, 'tokenizer.json'), 'utf8')));
  const queryEvidence = [];
  const textLatencies = [];
  for (const [query, expected] of LABELED_QUERIES) {
    const ids = tokenizer(query);
    const inputIds = new BigInt64Array(TEXT_LENGTH);
    const attentionMask = new BigInt64Array(TEXT_LENGTH);
    for (let index = 0; index < ids.length; index += 1) {
      inputIds[index] = BigInt(ids[index]);
      attentionMask[index] = 1n;
    }
    const feeds = {
      input_ids: new ort.Tensor('int64', inputIds, [1, TEXT_LENGTH]),
      attention_mask: new ort.Tensor('int64', attentionMask, [1, TEXT_LENGTH]),
    };
    await text.run(feeds);
    let queryVector;
    for (let round = 0; round < TEXT_ROUNDS; round += 1) {
      const started = performance.now();
      queryVector = vector(await text.run(feeds), 'text_embeds');
      textLatencies.push(performance.now() - started);
    }
    const ranked = [...imageVectors].map(([name, image]) => [name, cosine(queryVector, image)]).sort((left, right) => right[1] - left[1]);
    queryEvidence.push({ query, expected, actual: ranked[0][0], score: Number(ranked[0][1].toFixed(4)) });
  }

  const evidence = {
    model: manifest.version,
    sourceRevision: manifest.sourceRevision,
    bytes: manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0),
    runtime: { platform: process.platform, arch: process.arch, provider: 'cpu', node: process.version },
    budgets: {
      imagePhotosPerSecond: Number(photosPerSecond.toFixed(2)),
      imageMinimum: 5,
      textMedianMs: Number(median(textLatencies).toFixed(2)),
      textMaximumMs: 40,
    },
    retrieval: queryEvidence,
    passed: photosPerSecond >= 5 && median(textLatencies) <= 40 && queryEvidence.every((entry) => entry.actual === entry.expected),
  };
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.passed) process.exitCode = 1;
}

await main();
