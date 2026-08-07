import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createPhotoKitBridge } from '../../src/main/photo-kit/photo-kit-bridge.js';

describe('signed native PhotoKit bridge (#798)', () => {
  test('gates PhotoKit on a trusted packaged identity and uses least-privilege access levels', () => {
    const source = readFileSync(join(process.cwd(), 'native/touch-id/photokit.mm'), 'utf8');
    for (const contract of [
      'SecCodeCheckValidity',
      'kSecCodeSignatureAdhoc',
      'PHAccessLevelReadWrite',
      'PHAccessLevelAddOnly',
      'requestDataForAssetResource',
      'networkAccessAllowed = YES',
      'PHAssetCreationRequest',
      'originalFilename',
      'cancelDataRequest',
    ]) {
      assert.ok(source.includes(contract), `native bridge must enforce ${contract}`);
    }
    assert.match(readFileSync(join(process.cwd(), 'native/touch-id/photokit.cjs'), 'utf8'), /photokit\.node\.napi/u);
  });

  test('does not load on unsupported or unpackaged processes', () => {
    let loads = 0;
    const loadBinding = () => {
      loads += 1;
      return {};
    };
    assert.deepEqual(createPhotoKitBridge({ platform: 'win32', packaged: true, loadBinding }).status(), {
      available: false,
      reason: 'unsupported-platform',
    });
    assert.deepEqual(createPhotoKitBridge({ platform: 'darwin', packaged: false, loadBinding }).status(), {
      available: false,
      reason: 'unsigned-build',
    });
    assert.equal(loads, 0);
  });

  test('validates authorization, reviewed assets, materialization, and export callbacks', async () => {
    let cancelled = 0;
    const binding = {
      status: () => true,
      authorization: (access: string) => (access === 'add-only' ? 'authorized' : 'limited'),
      requestAuthorization: (_bundle: string, access: string, callback: (value: string) => void) => {
        callback(access === 'add-only' ? 'authorized' : 'limited');
      },
      assets: () => [
        { id: 'asset', fileName: 'IMG.JPG', mediaType: 'image', width: 20, height: 10, createdAt: null, latitude: null, longitude: null },
      ],
      materialize: (_bundle: string, _ids: readonly string[], destination: string, callback: (error: null, value: unknown) => void) => {
        callback(null, [
          {
            id: 'asset',
            fileName: 'IMG.JPG',
            mediaType: 'image',
            width: 20,
            height: 10,
            createdAt: null,
            latitude: null,
            longitude: null,
            path: `${destination}/IMG.JPG`,
          },
        ]);
      },
      exportAssets: (_bundle: string, _assets: unknown, callback: (error: null) => void) => callback(null),
      cancelAll: () => {
        cancelled += 1;
      },
    };
    const bridge = createPhotoKitBridge({ platform: 'darwin', packaged: true, loadBinding: () => binding });
    assert.deepEqual(bridge.status(), { available: true, reason: null });
    assert.equal(await bridge.requestAuthorization('read-write'), 'limited');
    assert.equal(bridge.assets()[0]?.id, 'asset');
    assert.equal((await bridge.materialize(['asset'], '/private/stage'))[0]?.path, '/private/stage/IMG.JPG');
    await bridge.exportAssets([
      {
        photoId: 'photo',
        path: '/private/stage/IMG.JPG',
        fileName: 'IMG.JPG',
        mediaType: 'image',
        createdAt: null,
        latitude: null,
        longitude: null,
      },
    ]);
    bridge.cancelAll();
    assert.equal(cancelled, 1);
  });
});
