import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  albumMembershipCommand,
  albumOrderCommand,
  favoriteCommand,
  favoritesCommand,
  moveCompensationCommand,
  trashCommand,
} from '../../src/main/history/command-drafts.js';

test('command drafts preserve exact reversible before/after state (#225, #614)', () => {
  assert.deepEqual(favoriteCommand('P1', true), {
    commandId: 'photo.favorite.toggle',
    classification: 'immediately-reversible',
    inverse: { kind: 'favorite', photoId: 'P1', before: false, after: true },
  });
  assert.deepEqual(
    favoritesCommand([
      { id: 'P1', favorite: true },
      { id: 'P2', favorite: false },
    ]),
    {
      commandId: 'photo.favorite.toggle',
      classification: 'immediately-reversible',
      inverse: {
        kind: 'favorites',
        changes: [
          { photoId: 'P1', before: false, after: true },
          { photoId: 'P2', before: true, after: false },
        ],
      },
    },
  );
  assert.equal(favoritesCommand([]), undefined);
  assert.equal(trashCommand([], 'trash'), undefined);
  assert.deepEqual(trashCommand(['P1'], 'restore'), {
    commandId: 'photo.restore',
    classification: 'conditionally-reversible',
    inverse: { kind: 'trash', photoIds: ['P1'], before: 'trashed', after: 'live' },
  });
  assert.equal(albumMembershipCommand('A1', [], 'add'), undefined);
  assert.deepEqual(albumMembershipCommand('A1', ['P1'], 'remove'), {
    commandId: 'album.membership.remove',
    classification: 'immediately-reversible',
    inverse: { kind: 'album-membership', albumId: 'A1', photoIds: ['P1'], before: 'present', after: 'absent' },
  });
  assert.equal(albumOrderCommand('album.reorder.up', 'A2', ['A1', 'A2'], ['A1', 'A2']), undefined);
  assert.deepEqual(albumOrderCommand('album.reorder.top', 'A2', ['A1', 'A2'], ['A2', 'A1']), {
    commandId: 'album.reorder.top',
    classification: 'immediately-reversible',
    inverse: { kind: 'album-order', albumId: 'A2', before: ['A1', 'A2'], after: ['A2', 'A1'] },
  });
  assert.deepEqual(
    moveCompensationCommand({ photoId: 'P1', contentHash: 'hash', sourcePath: '/source', byteCharge: 12, parentIdentity: 'parent' }),
    {
      commandId: 'library.import',
      classification: 'compensating-only',
      inverse: {
        kind: 'move-compensation',
        photoId: 'P1',
        contentHash: 'hash',
        sourcePath: '/source',
        byteCharge: 12,
        parentIdentity: 'parent',
      },
      byteCharge: 12,
      sensitive: true,
    },
  );
});
