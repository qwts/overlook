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

const REVISION = 'd15189d7028b43f1d3e65039190477f6af591c2a';
const SOURCE = `https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/${REVISION}`;

function asset(name: string, path: string, bytes: number, sha256: string): EmbeddingModelAsset {
  return { name, path, bytes, sha256, url: `${SOURCE}/${path}?download=true` };
}

/**
 * ADR-0018 measured-spike checkpoint: the quantized ViT-B/32 fallback.
 * The immutable source revision and every content digest are part of the
 * model version, so changing any asset necessarily requeues the index.
 */
export const EMBEDDING_MODEL_MANIFEST: EmbeddingModelManifest = {
  id: 'openclip-vit-b32-int8',
  version: `openclip-vit-b32-int8-${REVISION}`,
  family: 'CLIP ViT-B/32',
  sourceRevision: REVISION,
  dimensions: 512,
  imageSize: 224,
  license: 'MIT',
  assets: [
    asset('config.json', 'config.json', 4_524, '493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495'),
    asset('preprocessor_config.json', 'preprocessor_config.json', 520, '6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f'),
    asset('tokenizer.json', 'tokenizer.json', 2_224_119, 'f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd'),
    asset('tokenizer_config.json', 'tokenizer_config.json', 775, '60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967'),
    asset(
      'text_model_int8.onnx',
      'onnx/text_model_int8.onnx',
      64_070_791,
      '18845f2ccc35223bb7fec403383a131154b11ac0918df25cf51986df5efd3a21',
    ),
    asset(
      'vision_model_int8.onnx',
      'onnx/vision_model_int8.onnx',
      88_648_877,
      '0ab0c1b3ace708e539633af1744d5a95247fe4e14d3e08ff197ef82a6cb9bd93',
    ),
  ],
};

export const EMBEDDING_MODEL_BYTES = EMBEDDING_MODEL_MANIFEST.assets.reduce((sum, item) => sum + item.bytes, 0);
