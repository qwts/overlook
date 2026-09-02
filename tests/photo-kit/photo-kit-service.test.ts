import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import type { ImportSummary } from '../../src/main/import/import-engine.js';
import type { PhotoKitBridge, PhotoKitExportAsset, PhotoKitMaterializedAsset } from '../../src/main/photo-kit/photo-kit-bridge.js';
import { PhotoKitService } from '../../src/main/photo-kit/photo-kit-service.js';
import { cleanupPhotoKitStage } from '../../src/main/photo-kit/photo-kit-staging.js';
import type { PhotoRecord } from '../../src/shared/library/types.js';

const PHOTO: PhotoRecord = {
  id: 'photo',
  fileName: 'IMG.JPG',
  fileKind: 'jpeg',
  width: 20,
  height: 10,
  bytes: 5,
  contentHash: 'a'.repeat(64),
  derivativeKey: 'a'.repeat(64),
  variantSourceId: null,
  assetOwnerId: null,
  camera: null,
  lens: null,
  iso: null,
  aperture: null,
  shutter: null,
  focalLength: null,
  takenAt: '2026-08-07T00:00:00.000Z',
  gpsLat: 40,
  gpsLon: -80,
  place: null,
  title: null,
  description: null,
  tags: [],
  userTags: [],
  importedKeywords: [],
  suppressedKeywords: [],
  metadataVersion: 1,
  importedAt: '2026-08-07T00:00:00.000Z',
  importSource: 'fixture',
  favorite: false,
  isOriginal: true,
  keyId: 1,
  deletedAt: null,
  previewFailure: null,
  dimensionStatus: 'verified',
  mediaInfo: null,
  syncState: 'local',
  coverage: 'included',
  locked: false,
};

const SUMMARY: ImportSummary = {
  imported: 1,
  moved: 0,
  retained: 1,
  duplicates: 0,
  failed: 0,
  cancelled: 0,
  sidecars: 0,
  photoIds: ['imported'],
  moveCompensations: [],
};

class FakeBridge implements PhotoKitBridge {
  readonly asset = {
    id: 'asset',
    fileName: 'FROM-PHOTOS.JPG',
    mediaType: 'image' as const,
    width: 20,
    height: 10,
    createdAt: null,
    latitude: null,
    longitude: null,
  };
  exported: readonly PhotoKitExportAsset[] = [];
  exportedBytes = '';

  status() {
    return { available: true as const, reason: null };
  }
  authorization() {
    return 'authorized' as const;
  }
  requestAuthorization() {
    return Promise.resolve('authorized' as const);
  }
  assets() {
    return [this.asset];
  }
  async materialize(_assetIds: readonly string[], destination: string): Promise<readonly PhotoKitMaterializedAsset[]> {
    const target = join(destination, this.asset.fileName);
    await writeFile(target, 'photo', { mode: 0o600 });
    return [{ ...this.asset, path: target }];
  }
  async exportAssets(assets: readonly PhotoKitExportAsset[]): Promise<void> {
    this.exported = assets;
    this.exportedBytes = (await readFile(assets[0]!.path)).toString();
  }
  cancelAll() {}
  close() {}
}

describe('PhotoKit explicit transfer service (#798)', () => {
  test('binds import to an explicit review and journal-owned scratch cleanup', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'overlook-photokit-import-'));
    const bridge = new FakeBridge();
    let importedPath = '';
    const service = new PhotoKitService({
      bridge,
      dataDir,
      getPhoto: () => undefined,
      openOriginal: () => Promise.reject(new Error('unused')),
      importFiles: async (assets, cleanupPath, onJournaled) => {
        importedPath = assets[0]?.path ?? '';
        assert.equal((await readFile(importedPath)).toString(), 'photo');
        onJournaled();
        await cleanupPhotoKitStage(dataDir, cleanupPath);
        return SUMMARY;
      },
      cancelImport: () => undefined,
      admit: () => true,
      progress: () => undefined,
    });
    const review = await service.reviewImport();
    assert.equal(review.status, 'ready');
    assert.equal((await service.runImport(review.reviewId!, ['asset'])).imported, 1);
    assert.match(importedPath.replaceAll('\\', '/'), /photokit-transfers\/transfer-/u);
    await assert.rejects(service.runImport(review.reviewId!, ['other']), /stale or invalid/u);
  });

  test('cleans plaintext staging when the import path rejects before journal custody (#798 review)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'overlook-photokit-prejournal-'));
    const bridge = new FakeBridge();
    let cleanupPath = '';
    const service = new PhotoKitService({
      bridge,
      dataDir,
      getPhoto: () => undefined,
      openOriginal: () => Promise.reject(new Error('unused')),
      importFiles: (_assets, path) => {
        cleanupPath = path;
        return Promise.reject(new Error('import service is closed'));
      },
      cancelImport: () => undefined,
      admit: () => true,
      progress: () => undefined,
    });
    const review = await service.reviewImport();

    await assert.rejects(service.runImport(review.reviewId!, ['asset']), /import service is closed/u);
    assert.equal(existsSync(cleanupPath), false);
  });

  test('exports only ordinary selected originals and releases temporary custody', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'overlook-photokit-export-'));
    const bridge = new FakeBridge();
    let releases = 0;
    const progress: string[] = [];
    const service = new PhotoKitService({
      bridge,
      dataDir,
      getPhoto: (photoId) => (photoId === PHOTO.id ? PHOTO : undefined),
      openOriginal: () =>
        Promise.resolve({
          stream: Readable.from(['bytes']),
          release: () => {
            releases += 1;
            return Promise.resolve();
          },
        }),
      importFiles: () => Promise.reject(new Error('unused')),
      cancelImport: () => undefined,
      admit: () => true,
      progress: ({ operation, phase }) => progress.push(`${operation}:${phase}`),
    });
    const result = await service.runExport(['photo', 'protected-or-missing']);
    assert.deepEqual({ exported: result.exported, failed: result.failed }, { exported: 1, failed: 1 });
    assert.equal(bridge.exportedBytes, 'bytes');
    assert.deepEqual(
      bridge.exported.map(({ photoId, fileName, createdAt, latitude, longitude }) => ({
        photoId,
        fileName,
        createdAt,
        latitude,
        longitude,
      })),
      [{ photoId: 'photo', fileName: 'IMG.JPG', createdAt: PHOTO.takenAt, latitude: 40, longitude: -80 }],
    );
    assert.equal(releases, 1);
    assert.ok(progress.includes('export:transferring'));
  });

  test('fails closed when lock authority is unavailable', async () => {
    const bridge = new FakeBridge();
    const service = new PhotoKitService({
      bridge,
      dataDir: mkdtempSync(join(tmpdir(), 'overlook-photokit-locked-')),
      getPhoto: () => PHOTO,
      openOriginal: () => Promise.reject(new Error('must not open')),
      importFiles: () => Promise.reject(new Error('must not import')),
      cancelImport: () => undefined,
      admit: () => false,
      progress: () => undefined,
    });
    assert.equal((await service.reviewImport()).status, 'cancelled');
    const result = await service.runExport(['photo']);
    assert.deepEqual({ exported: result.exported, failed: result.failed }, { exported: 0, failed: 1 });
  });
});
