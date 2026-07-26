import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { ModelAssetConsentError, ModelAssetIntegrityError, ModelAssetManager } from '../../src/main/embedding/model-assets.js';
import type { EmbeddingModelManifest } from '../../src/main/embedding/model-manifest.js';

function manifest(bytes: Uint8Array): EmbeddingModelManifest {
  return {
    id: 'fixture-model',
    version: 'fixture-model-v1',
    family: 'fixture',
    sourceRevision: 'fixture-revision',
    dimensions: 512,
    imageSize: 224,
    license: 'MIT',
    assets: [
      {
        name: 'model.onnx',
        path: 'onnx/model.onnx',
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        url: 'https://models.invalid/model.onnx',
      },
    ],
  };
}

describe('ModelAssetManager', () => {
  test('a missing model never touches the network without explicit consent', async () => {
    let requests = 0;
    const manager = new ModelAssetManager({
      cacheRoot: mkdtempSync(join(tmpdir(), 'overlook-model-consent-')),
      manifest: manifest(new Uint8Array([1, 2, 3])),
      fetch: () => {
        requests += 1;
        return Promise.resolve(new Response());
      },
    });

    await assert.rejects(manager.ensureInstalled(false), ModelAssetConsentError);
    assert.equal(requests, 0);
    assert.equal(await manager.installed(), false);
  });

  test('streams, verifies, atomically installs, and reuses a pinned asset', async () => {
    const bytes = new Uint8Array([7, 8, 9, 10]);
    let requests = 0;
    const progress: number[] = [];
    const manager = new ModelAssetManager({
      cacheRoot: mkdtempSync(join(tmpdir(), 'overlook-model-valid-')),
      manifest: manifest(bytes),
      fetch: () => {
        requests += 1;
        return Promise.resolve(new Response(bytes));
      },
    });

    await manager.ensureInstalled(true, (value) => progress.push(value.downloadedBytes));
    await manager.ensureInstalled(true);

    assert.equal(requests, 1);
    assert.equal(await manager.installed(), true);
    assert.deepEqual(readFileSync(manager.assetPath('model.onnx')), Buffer.from(bytes));
    assert.equal(progress.at(-1), bytes.byteLength);
  });

  test('rejects corrupt bytes and removes partial and final files', async () => {
    const expected = new Uint8Array([1, 2, 3]);
    const manager = new ModelAssetManager({
      cacheRoot: mkdtempSync(join(tmpdir(), 'overlook-model-corrupt-')),
      manifest: manifest(expected),
      fetch: () => Promise.resolve(new Response(new Uint8Array([3, 2, 1]))),
    });

    await assert.rejects(manager.ensureInstalled(true), ModelAssetIntegrityError);
    assert.equal(existsSync(manager.assetPath('model.onnx')), false);
    assert.equal(existsSync(`${manager.assetPath('model.onnx')}.part`), false);
  });
});
