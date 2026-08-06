import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { providerDescriptorSchema, providerIdSchema } from '../../src/shared/backup/provider-descriptor.js';

describe('provider descriptor contract (#280)', () => {
  test('accepts stable ids and explicit capabilities without assuming quota', () => {
    const descriptor = providerDescriptorSchema.parse({
      id: 'future-cloud',
      label: 'Future Cloud',
      capabilities: {
        quota: 'unknown',
        verification: 'download-hash',
        resumableUpload: false,
        platforms: ['darwin'],
        interactiveAuth: true,
        reconnectRequired: true,
        accountIdentity: 'stable-subject',
      },
      available: false,
      unavailableReason: 'Adapter not installed.',
    });

    assert.equal(descriptor.capabilities.quota, 'unknown');
    assert.equal(descriptor.available, false);
  });

  test('rejects ids that cannot be safe persisted registry keys', () => {
    for (const id of ['', 'PCLOUD', '../cloud', 'cloud provider', '1cloud']) {
      assert.equal(providerIdSchema.safeParse(id).success, false, id);
    }
  });
});
