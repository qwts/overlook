import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TestFileProviderBridge } from '../../src/main/file-provider/test-file-provider-bridge.js';

describe('File Provider E2E bridge (#797)', () => {
  test('provides a complete no-op domain lifecycle over the fixture directory', async () => {
    const bridge = new TestFileProviderBridge('/tmp/overlook-file-provider-fixture');
    assert.deepEqual(bridge.status(), { available: true, reason: null });
    assert.equal(bridge.stateDirectory(), '/tmp/overlook-file-provider-fixture');
    await bridge.register({ id: 'domain', displayName: 'Library' });
    await bridge.changed('domain', ['root']);
    await bridge.evict('domain');
    await bridge.remove('domain');
    bridge.close();
  });
});
