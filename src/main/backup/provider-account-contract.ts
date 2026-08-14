import assert from 'node:assert/strict';

import type { ProviderAccountIdentity, StorageProvider } from './provider.js';

/** Shared stable-subject contract used by every deterministic adapter suite. */
export async function exerciseProviderAccountContract(provider: StorageProvider, expected: ProviderAccountIdentity): Promise<void> {
  assert.equal(provider.capabilities.accountIdentity, 'stable-subject');
  const first = await provider.accountIdentity();
  const repeated = await provider.accountIdentity();
  assert.deepEqual(first, expected);
  assert.deepEqual(repeated, expected, 'repeated reads name the same account');
  assert.notEqual(first.accountId, first.accountLabel, 'stable subject is not a display label');
}
