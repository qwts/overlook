import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import type { CustodyAuthority } from '../../src/main/backup/custody-authority-repository.js';
import { CustodyHandleResolver, CustodyResolutionError, custodyRemoteRoot } from '../../src/main/backup/custody-handle.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import type { StorageProvider } from '../../src/main/backup/provider.js';

const root = custodyRemoteRoot('library-a');

function authority(overrides: Partial<CustodyAuthority> = {}): CustodyAuthority {
  return {
    id: 1,
    providerId: 'bound-provider',
    accountId: 'bound-account',
    accountLabel: 'bound@example.test',
    remoteRoot: root,
    state: 'bound',
    createdAt: '2026-08-06T00:00:00.000Z',
    lastVerifiedAt: null,
    ...overrides,
  };
}

function provider(accountId = 'bound-account'): MockProvider {
  const mock = new MockProvider({
    rootDir: mkdtempSync(join(tmpdir(), 'overlook-custody-handle-')),
    libraryId: 'library-a',
    accountIdentity: { accountId, accountLabel: `${accountId}@example.test` },
  });
  Object.defineProperty(mock, 'id', { value: 'bound-provider' });
  return mock;
}

async function rejectsWithReason(operation: Promise<unknown>, reason: CustodyResolutionError['reason']): Promise<void> {
  await assert.rejects(operation, (error: unknown) => error instanceof CustodyResolutionError && error.reason === reason);
}

describe('binding-addressed custody handle (#731)', () => {
  test('resolves only the provider, account, and remote-root triple recorded on the row', async () => {
    const recorded = authority();
    const bound = provider();
    const calls: string[] = [];
    const resolver = new CustodyHandleResolver({
      authorityForPhoto: (photoId) => (photoId === 'photo-a' ? recorded : undefined),
      provider: (providerId) => {
        calls.push(providerId);
        return providerId === 'bound-provider' ? bound : undefined;
      },
      remoteRoot: () => root,
    });

    assert.deepEqual(await resolver.resolve('photo-a'), { authority: recorded, provider: bound });
    assert.deepEqual(calls, ['bound-provider']);
    await rejectsWithReason(resolver.resolve('unbound-photo'), 'custody-unavailable');
    assert.deepEqual(calls, ['bound-provider'], 'an unbound row never falls back to the selected provider');
  });

  test('fails closed with distinct disconnected, wrong-account, and unavailable reasons', async () => {
    const disconnected = provider();
    disconnected.setConnected(false);

    const resolve = (recorded: CustodyAuthority, candidate: StorageProvider | undefined, liveRoot = root) =>
      new CustodyHandleResolver({
        authorityForPhoto: () => recorded,
        provider: () => candidate,
        remoteRoot: () => liveRoot,
      }).resolve('photo-a');

    await rejectsWithReason(resolve(authority(), undefined), 'custody-disconnected');
    await rejectsWithReason(resolve(authority({ state: 'provider-required' }), provider()), 'custody-disconnected');
    await rejectsWithReason(resolve(authority(), disconnected), 'custody-disconnected');
    await rejectsWithReason(resolve(authority(), provider('different-account')), 'custody-wrong-account');
    await rejectsWithReason(resolve(authority(), provider(), custodyRemoteRoot('library-b')), 'custody-unavailable');
  });
});
