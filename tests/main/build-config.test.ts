import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bundledGoogleDriveClientId,
  bundledGoogleDriveClientSecret,
  imageTrailExtensionId,
  pcloudFeatureConfig,
} from '../../src/main/build-config.js';

test('unconfigured Google Drive build credentials fail closed', () => {
  assert.equal(bundledGoogleDriveClientId(), null);
  assert.equal(bundledGoogleDriveClientSecret(), null);
});

test('pCloud is enabled by a supplied client ID and remains fail-closed without one', () => {
  assert.deepEqual(
    pcloudFeatureConfig(() => undefined),
    { enabled: false, clientId: null },
  );
  assert.deepEqual(
    pcloudFeatureConfig((name) => (name === 'OVERLOOK_PCLOUD_ENABLED' ? '1' : undefined)),
    {
      enabled: false,
      clientId: null,
    },
  );
  assert.deepEqual(
    pcloudFeatureConfig((name) => (name === 'OVERLOOK_PCLOUD_CLIENT_ID' ? 'public-test-id' : undefined)),
    { enabled: true, clientId: 'public-test-id' },
  );
});

test('pCloud retains an explicit feature kill switch', () => {
  assert.deepEqual(
    pcloudFeatureConfig((name) =>
      name === 'OVERLOOK_PCLOUD_ENABLED' ? '0' : name === 'OVERLOOK_PCLOUD_CLIENT_ID' ? 'public-test-id' : undefined,
    ),
    { enabled: false, clientId: null },
  );
  assert.deepEqual(
    pcloudFeatureConfig((name) =>
      name === 'OVERLOOK_PCLOUD_ENABLED' ? '1' : name === 'OVERLOOK_PCLOUD_CLIENT_ID' ? 'public-test-id' : undefined,
    ),
    { enabled: true, clientId: 'public-test-id' },
  );
});

test('Image Trail native messaging accepts only a canonical Chromium extension ID', () => {
  assert.equal(
    imageTrailExtensionId(() => undefined),
    null,
  );
  assert.equal(
    imageTrailExtensionId((name) => (name === 'OVERLOOK_IMAGE_TRAIL_EXTENSION_ID' ? 'abcdefghijklmnopabcdefghijklmnop' : undefined)),
    'abcdefghijklmnopabcdefghijklmnop',
  );
  assert.equal(
    imageTrailExtensionId(() => 'released-extension-id'),
    null,
  );
});
