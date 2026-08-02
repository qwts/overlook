import type { ChipFilters, LibraryMembershipChange, PageRequest } from './types.js';

export function membershipChanged(
  membership: LibraryMembershipChange | undefined,
  source: PageRequest['source'],
  chips: ChipFilters,
  album: string | null,
  albumIds?: readonly string[],
): boolean {
  if (membership === undefined || membership === 'none') return false;
  if (membership === 'favorite') return source === 'favorites' || chips.favorites === true;
  if (membership === 'album') return album !== null && (albumIds === undefined || albumIds.includes(album));
  return true;
}
