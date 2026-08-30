import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { TestPhotoKitBridge } from '../../src/main/photo-kit/test-photo-kit-bridge.js';
import {
  cleanupPhotoKitOrphans,
  cleanupPhotoKitStage,
  createPhotoKitStage,
  isPhotoKitStage,
} from '../../src/main/photo-kit/photo-kit-staging.js';

describe('PhotoKit test bridge fixtures (#798)', () => {
  test('discovers media, materializes private copies, and exports selected assets', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'overlook-photokit-fixture-'));
    const destination = mkdtempSync(join(tmpdir(), 'overlook-photokit-export-'));
    const stage = join(fixture, 'stage');
    await Promise.all([
      writeFile(join(fixture, 'IMG.JPG'), 'image'),
      writeFile(join(fixture, 'CLIP.MP4'), 'video'),
      writeFile(join(fixture, 'notes.txt'), 'ignored'),
      mkdir(join(fixture, 'folder')),
    ]);

    const bridge = new TestPhotoKitBridge(fixture, destination);
    assert.deepEqual(bridge.status(), { available: true, reason: null });
    assert.equal(bridge.authorization('read-write'), 'authorized');
    assert.equal(await bridge.requestAuthorization('add-only'), 'authorized');
    const assets = [...bridge.assets()].sort((left, right) => left.fileName.localeCompare(right.fileName));
    assert.deepEqual(
      assets.map(({ fileName, mediaType }) => ({ fileName, mediaType })),
      [
        { fileName: 'CLIP.MP4', mediaType: 'video' },
        { fileName: 'IMG.JPG', mediaType: 'image' },
      ],
    );
    assert.ok(assets.every((asset) => !('sourcePath' in asset)));

    const materialized = await bridge.materialize(
      assets.map((asset) => asset.id),
      stage,
    );
    assert.deepEqual(await Promise.all(materialized.map(async (asset) => (await readFile(asset.path)).toString())), ['video', 'image']);
    if (process.platform !== 'win32') {
      assert.ok((await Promise.all(materialized.map((asset) => stat(asset.path)))).every((details) => (details.mode & 0o077) === 0));
    }
    await assert.rejects(bridge.materialize(['missing'], stage), /unavailable/u);

    await bridge.exportAssets([
      {
        photoId: 'photo',
        path: materialized[1]!.path,
        fileName: 'EXPORTED.JPG',
        mediaType: 'image',
        createdAt: null,
        latitude: null,
        longitude: null,
      },
    ]);
    assert.equal((await readFile(join(destination, 'EXPORTED.JPG'))).toString(), 'image');
    bridge.cancelAll();
    bridge.close();
    assert.deepEqual(bridge.status(), { available: false, reason: null });
    assert.equal(bridge.authorization('read-write'), 'denied');
  });

  test('supports empty import fixtures and rejects an unavailable export fixture', async () => {
    const bridge = new TestPhotoKitBridge(undefined, undefined);
    assert.deepEqual(bridge.assets(), []);
    await assert.rejects(bridge.exportAssets([]), /unavailable/u);
  });
});

describe('PhotoKit staging ownership (#798)', () => {
  test('recognizes only direct transfer children and removes only owned stages', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'overlook-photokit-stage-'));
    const stage = await createPhotoKitStage(dataDir);
    const nested = join(stage, 'nested');
    await mkdir(nested);
    assert.equal(isPhotoKitStage(dataDir, stage), true);
    assert.equal(isPhotoKitStage(dataDir, nested), false);
    assert.equal(isPhotoKitStage(dataDir, join(dataDir, 'photokit-transfers')), false);
    assert.equal(isPhotoKitStage(dataDir, join(dataDir, 'elsewhere')), false);
    await cleanupPhotoKitStage(dataDir, nested);
    assert.equal(existsSync(nested), true);
    await cleanupPhotoKitStage(dataDir, stage);
    assert.equal(existsSync(stage), false);
  });

  test('removes transfer orphans while preserving the active stage and unrelated entries', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'overlook-photokit-orphans-'));
    await cleanupPhotoKitOrphans(dataDir, null);
    const preserved = await createPhotoKitStage(dataDir);
    const orphan = await createPhotoKitStage(dataDir);
    const root = join(dataDir, 'photokit-transfers');
    const unrelated = join(root, 'keep-me');
    await mkdir(unrelated);
    await writeFile(join(root, 'transfer-file'), 'not a directory');

    await cleanupPhotoKitOrphans(dataDir, preserved);
    assert.equal(existsSync(preserved), true);
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(unrelated), true);
    await cleanupPhotoKitOrphans(dataDir, null);
    assert.equal(existsSync(preserved), false);
  });
});
