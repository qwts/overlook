import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ExportDestinationAuthority } from '../../src/main/export/export-destination-authority.js';

const selected = { operation: 'selected', photoIds: ['photo-a'], format: 'original', metadata: 'original' } as const;

describe('ExportDestinationAuthority', () => {
  test('binds one-use grants to the exact renderer and request', () => {
    const authority = new ExportDestinationAuthority();
    const authorization = authority.issue(7, selected, '/chosen', 1_000);

    assert.throws(() => authority.consume(8, selected, authorization, 1_001), /invalid or expired/u);
    assert.equal(authority.consume(7, selected, authorization, 1_001), '/chosen');
    assert.throws(() => authority.consume(7, selected, authorization, 1_002), /invalid or expired/u);
  });

  test('rejects request changes without destroying the valid grant', () => {
    const authority = new ExportDestinationAuthority();
    const authorization = authority.issue(7, selected, '/chosen', 1_000);

    assert.throws(() => authority.consume(7, { ...selected, photoIds: ['photo-b'] }, authorization, 1_001), /invalid or expired/u);
    assert.equal(authority.consume(7, selected, authorization, 1_002), '/chosen');
  });

  test('expires grants, supersedes reselections, and revokes abandonment', () => {
    const authority = new ExportDestinationAuthority(100);
    const expired = authority.issue(7, selected, '/expired', 1_000);
    assert.throws(() => authority.consume(7, selected, expired, 1_100), /invalid or expired/u);

    const oldAuthorization = authority.issue(7, selected, '/old', 2_000);
    const nextAuthorization = authority.issue(7, selected, '/next', 2_001);
    assert.throws(() => authority.consume(7, selected, oldAuthorization, 2_002), /invalid or expired/u);
    assert.equal(authority.revoke(7, nextAuthorization, 2_002), true);
    assert.equal(authority.revoke(7, nextAuthorization, 2_003), false);
    assert.throws(() => authority.consume(7, selected, nextAuthorization, 2_003), /invalid or expired/u);
  });

  test('isolates selected, all, moodboard, and protected export operations', () => {
    const intents = [
      selected,
      { operation: 'all', metadata: 'none' } as const,
      { operation: 'board', request: { board: { id: 'board-a' } } } as const,
      { operation: 'protected', albumId: 'album-a', photoIds: ['photo-a'], format: 'jpeg' } as const,
    ];

    for (const [index, intent] of intents.entries()) {
      const authority = new ExportDestinationAuthority();
      const authorization = authority.issue(7, intent, `/chosen/${index}`, 1_000);
      assert.equal(authority.consume(7, intent, authorization, 1_001), `/chosen/${index}`);
    }
  });
});
