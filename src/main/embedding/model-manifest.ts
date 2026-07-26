export interface EmbeddingModelAsset {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly url: string;
}

export interface EmbeddingModelManifest {
  readonly id: string;
  readonly version: string;
  readonly family: string;
  readonly sourceRevision: string;
  readonly dimensions: number;
  readonly imageSize: number;
  readonly license: string;
  readonly assets: readonly EmbeddingModelAsset[];
}

/**
 * ADR-0018 measured-spike checkpoint: the quantized ViT-B/32 fallback.
 * The immutable source revision and every content digest are part of the
 * model version, so changing any asset necessarily requeues the index.
 */
export const EMBEDDING_MODEL_MANIFEST: EmbeddingModelManifest = manifest;

export const EMBEDDING_MODEL_BYTES = EMBEDDING_MODEL_MANIFEST.assets.reduce((sum, item) => sum + item.bytes, 0);
import manifest from './model-manifest.json' with { type: 'json' };
