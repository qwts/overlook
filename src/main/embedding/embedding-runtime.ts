import { buffer } from 'node:stream/consumers';

import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { BlobStore } from '../blobs/blob-store.js';
import type { KeyResolver } from '../crypto/envelope.js';
import { EmbeddingRepository } from '../db/embedding-repository.js';
import { EmbeddingInputError, EmbeddingPool } from './embedding-pool.js';
import { EmbeddingService, type EmbeddingPauseReason, type EmbeddingStatus } from './embedding-service.js';
import { ModelAssetManager } from './model-assets.js';

export interface EmbeddingRuntimeOptions {
  readonly db: BetterSqlite3.Database;
  readonly blobs: BlobStore;
  readonly resolveKey: KeyResolver;
  readonly modelCacheRoot: string;
  readonly workerUrl: URL;
  readonly providers: readonly string[];
  readonly enabled: () => boolean;
  readonly setEnabled: (enabled: boolean) => void;
  readonly pauseReason: () => Exclude<EmbeddingPauseReason, 'user'> | null;
  readonly emit: (status: EmbeddingStatus) => void;
  readonly available?: boolean;
  readonly unavailableReason?: string;
}

export interface EmbeddingRuntime {
  readonly service: EmbeddingService;
  readonly close: () => Promise<void>;
}

export function createEmbeddingRuntime(options: EmbeddingRuntimeOptions): EmbeddingRuntime {
  const assets = new ModelAssetManager({ cacheRoot: options.modelCacheRoot });
  const pool = new EmbeddingPool({
    workerUrl: options.workerUrl,
    modelPath: assets.assetPath('vision_model_int8.onnx'),
    textModelPath: assets.assetPath('text_model_int8.onnx'),
    tokenizerPath: assets.assetPath('tokenizer.json'),
    providers: options.providers,
  });
  const service = new EmbeddingService({
    repository: new EmbeddingRepository(options.db),
    assets,
    enabled: options.enabled,
    setEnabled: options.setEnabled,
    pauseReason: options.pauseReason,
    load: async (candidate, signal) => {
      if (signal.aborted) throw signal.reason;
      try {
        const bytes = await buffer(options.blobs.getThumbStream(candidate.contentHash, 'mid', options.resolveKey, candidate.photoId));
        if (signal.aborted) {
          bytes.fill(0);
          throw signal.reason;
        }
        if (bytes.length <= 32 * 1024 * 1024) return bytes;
        bytes.fill(0);
        return null;
      } catch (error) {
        if (signal.aborted) throw error;
        return null;
      }
    },
    embed: async (bytes, signal) => {
      try {
        return await pool.embed(bytes, signal);
      } catch (error) {
        if (error instanceof EmbeddingInputError) return null;
        throw error;
      }
    },
    embedText: (text, signal) => pool.embedText(text, signal),
    emit: options.emit,
    ...(options.available === undefined ? {} : { available: options.available }),
    ...(options.unavailableReason === undefined ? {} : { unavailableReason: options.unavailableReason }),
  });
  service.start();
  return {
    service,
    close: async () => {
      await service.close();
      await pool.close();
    },
  };
}

export function executionProviders(platform = process.platform): readonly string[] {
  if (platform === 'darwin') return ['coreml', 'cpu'];
  if (platform === 'win32') return ['dml', 'cpu'];
  return ['cpu'];
}
