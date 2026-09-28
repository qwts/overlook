import type { LibraryDescriptor } from '../../../shared/library/registry.js';

// Library switcher row actions (#1299, Pass D). The ⋯ menu always lists the
// same four actions; one a row cannot take stays in the menu, disabled with
// the reason. These are the checks that used to hide the row's buttons.

export type LibraryRowState = 'open' | 'available' | 'missing' | 'elsewhere';

export type LibraryActionBlock =
  { readonly reason: 'open' } | { readonly reason: 'missing' } | { readonly reason: 'elsewhere'; readonly host: string };

export interface LibraryRowActions {
  readonly displayName: LibraryActionBlock | null;
  readonly rename: LibraryActionBlock | null;
  readonly move: LibraryActionBlock | null;
  readonly remove: LibraryActionBlock | null;
}

export function libraryRowState(library: LibraryDescriptor, currentId: string | null): LibraryRowState {
  if (library.missing) return 'missing';
  if (library.lockedBy !== null) return 'elsewhere';
  if (library.open || library.id === currentId) return 'open';
  return 'available';
}

export function libraryRowActions(library: LibraryDescriptor, currentId: string | null): LibraryRowActions {
  const state = libraryRowState(library, currentId);
  // Renaming or moving the folder needs the folder, and needs this instance
  // to hold it.
  const relocation: LibraryActionBlock | null =
    state === 'missing'
      ? { reason: 'missing' }
      : state === 'elsewhere' && library.lockedBy !== null
        ? { reason: 'elsewhere', host: library.lockedBy }
        : null;
  return {
    displayName: null,
    rename: relocation,
    move: relocation,
    remove: state === 'open' ? { reason: 'open' } : null,
  };
}
