import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';

import {
  EMBEDDING_MODEL_BYTES,
  EMBEDDING_MODEL_MANIFEST,
  type EmbeddingModelAsset,
  type EmbeddingModelManifest,
} from './model-manifest.js';

export interface ModelDownloadProgress {
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly asset: string;
}

export class ModelAssetConsentError extends Error {
  override readonly name = 'ModelAssetConsentError';
}

export class ModelAssetIntegrityError extends Error {
  override readonly name = 'ModelAssetIntegrityError';
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function validAsset(path: string, asset: EmbeddingModelAsset): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size === asset.bytes && (await digestFile(path)) === asset.sha256;
  } catch {
    return false;
  }
}

export interface ModelAssetManagerOptions {
  readonly cacheRoot: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly manifest?: EmbeddingModelManifest;
}

/** Explicit-consent, hash-pinned model cache. No caller means no network. */
export class ModelAssetManager {
  private readonly modelDir: string;
  private readonly fetchAsset: typeof globalThis.fetch;
  private readonly manifest: EmbeddingModelManifest;
  private readonly totalBytes: number;

  constructor(options: ModelAssetManagerOptions) {
    this.manifest = options.manifest ?? EMBEDDING_MODEL_MANIFEST;
    this.modelDir = join(options.cacheRoot, this.manifest.id);
    this.fetchAsset = options.fetch ?? globalThis.fetch;
    this.totalBytes =
      this.manifest === EMBEDDING_MODEL_MANIFEST ? EMBEDDING_MODEL_BYTES : this.manifest.assets.reduce((sum, item) => sum + item.bytes, 0);
  }

  assetPath(name: string): string {
    return join(this.modelDir, name);
  }

  async installed(): Promise<boolean> {
    for (const asset of this.manifest.assets) {
      if (!(await validAsset(this.assetPath(asset.name), asset))) return false;
    }
    return true;
  }

  async ensureInstalled(
    consent: boolean,
    progress: (value: ModelDownloadProgress) => void = () => undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (await this.installed()) {
      progress({ downloadedBytes: this.totalBytes, totalBytes: this.totalBytes, asset: '' });
      return;
    }
    if (!consent) throw new ModelAssetConsentError('model download requires explicit consent');
    await mkdir(this.modelDir, { recursive: true });
    let downloadedBytes = 0;
    for (const asset of this.manifest.assets) {
      const finalPath = this.assetPath(asset.name);
      if (await validAsset(finalPath, asset)) {
        downloadedBytes += asset.bytes;
        progress({ downloadedBytes, totalBytes: this.totalBytes, asset: asset.name });
        continue;
      }
      await rm(finalPath, { force: true });
      const partialPath = `${finalPath}.part`;
      await rm(partialPath, { force: true });
      try {
        const requestInit: RequestInit = signal === undefined ? { redirect: 'follow' } : { redirect: 'follow', signal };
        const response = await this.fetchAsset(asset.url, requestInit);
        if (!response.ok || response.body === null) throw new Error(`model asset request failed with ${String(response.status)}`);
        const hash = createHash('sha256');
        let assetBytes = 0;
        const totalBytes = this.totalBytes;
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            assetBytes += chunk.length;
            progress({
              downloadedBytes: downloadedBytes + assetBytes,
              totalBytes,
              asset: asset.name,
            });
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
          meter,
          createWriteStream(partialPath, { flags: 'wx' }),
          { signal },
        );
        const digest = hash.digest('hex');
        if (assetBytes !== asset.bytes || digest !== asset.sha256) {
          throw new ModelAssetIntegrityError(`model asset ${asset.name} failed integrity verification`);
        }
        await rename(partialPath, finalPath);
        downloadedBytes += asset.bytes;
      } catch (error) {
        await rm(partialPath, { force: true });
        await rm(finalPath, { force: true });
        throw error;
      }
    }
    if (!(await this.installed())) throw new ModelAssetIntegrityError('model installation did not verify');
  }
}
