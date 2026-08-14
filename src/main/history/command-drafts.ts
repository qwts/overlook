import type { CommandDraft } from '../activity/activity-publication.js';
import type { CommandId } from '../../shared/commands/registry.js';

export function boardLayoutCommand(boardId: string, before: string | null, after: string): CommandDraft | undefined {
  // No command for the first save (nothing to undo to) or a no-op save.
  if (before === null || before === after) return undefined;
  return {
    commandId: 'board.layout',
    classification: 'immediately-reversible',
    inverse: { kind: 'board-layout', boardId, before, after },
  };
}

export function favoriteCommand(photoId: string, favorite: boolean): CommandDraft {
  return {
    commandId: 'photo.favorite.toggle',
    classification: 'immediately-reversible',
    inverse: { kind: 'favorite', photoId, before: !favorite, after: favorite },
  };
}

export function favoritesCommand(changes: readonly { readonly id: string; readonly favorite: boolean }[]): CommandDraft | undefined {
  if (changes.length === 0) return undefined;
  return {
    commandId: 'photo.favorite.toggle',
    classification: 'immediately-reversible',
    inverse: {
      kind: 'favorites',
      changes: changes.map(({ id, favorite }) => ({ photoId: id, before: !favorite, after: favorite })),
    },
  };
}

export function trashCommand(photoIds: readonly string[], operation: 'trash' | 'restore'): CommandDraft | undefined {
  if (photoIds.length === 0) return undefined;
  return {
    commandId: operation === 'trash' ? 'photo.trash' : 'photo.restore',
    classification: 'conditionally-reversible',
    inverse: {
      kind: 'trash',
      photoIds,
      before: operation === 'trash' ? 'live' : 'trashed',
      after: operation === 'trash' ? 'trashed' : 'live',
    },
  };
}

export function albumMembershipCommand(
  albumId: string,
  photoIds: readonly string[],
  operation: 'add' | 'remove',
): CommandDraft | undefined {
  if (photoIds.length === 0) return undefined;
  return {
    commandId: operation === 'add' ? 'album.membership.add' : 'album.membership.remove',
    classification: 'immediately-reversible',
    inverse: {
      kind: 'album-membership',
      albumId,
      photoIds,
      before: operation === 'add' ? 'absent' : 'present',
      after: operation === 'add' ? 'present' : 'absent',
    },
  };
}

export function albumOrderCommand(
  commandId: Extract<CommandId, `album.reorder.${string}`>,
  albumId: string,
  before: readonly string[],
  after: readonly string[],
): CommandDraft | undefined {
  if (before.length === after.length && before.every((id, index) => id === after[index])) return undefined;
  return {
    commandId,
    classification: 'immediately-reversible',
    inverse: { kind: 'album-order', albumId, before: [...before], after: [...after] },
  };
}

export function moveCompensationCommand(candidate: {
  readonly photoId: string;
  readonly contentHash: string;
  readonly sourcePath: string;
  readonly byteCharge: number;
  readonly parentIdentity: string;
}): CommandDraft {
  return {
    commandId: 'library.import',
    classification: 'compensating-only',
    inverse: { kind: 'move-compensation', ...candidate },
    byteCharge: candidate.byteCharge,
    sensitive: true,
  };
}
