import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveProviderTargetId } from '../../src/renderer/src/settings/provider-presentation.js';

const providers = [{ id: 'pcloud' }, { id: 'google-drive' }, { id: 'icloud-drive' }];

test('provider presentation preserves a disconnected target across Settings remounts', () => {
  assert.equal(resolveProviderTargetId(providers, null, 'google-drive', 'google-drive', 'pcloud'), 'google-drive');
  assert.equal(resolveProviderTargetId(providers, null, null, 'google-drive', 'pcloud'), 'google-drive');
});

test('provider presentation gives connected and current dialog selections precedence', () => {
  assert.equal(resolveProviderTargetId(providers, 'icloud-drive', 'google-drive', 'google-drive', 'pcloud'), 'icloud-drive');
  assert.equal(resolveProviderTargetId(providers, null, 'icloud-drive', 'google-drive', 'pcloud'), 'icloud-drive');
});
