import type { ComponentProps, ReactElement } from 'react';

import { LibraryGridView } from '../grid/LibraryGridView';
import { MoodboardRoute } from '../moodboard/MoodboardRoute';
import { useAppState } from '../state/app-state-context';
import type { Board } from '../../../shared/moodboard/board.js';
import type { PlacementAvailability } from '../../../shared/moodboard/availability.js';

// The primary (non-protected) library content router (#693): the Moodboard
// canvas when the board view is active, otherwise the grid/list view. Keeps the
// Shell's content branch to a single element.
export function PrimaryLibraryView(
  props: ComponentProps<typeof LibraryGridView> & {
    readonly onBoardExport: (request: {
      readonly board: Board;
      readonly availability: Readonly<Record<string, PlacementAvailability>>;
    }) => void;
  },
): ReactElement {
  const state = useAppState();
  const { onBoardExport, ...gridProps } = props;
  if (state.view === 'moodboard') {
    return <MoodboardRoute photos={state.photos} onExport={onBoardExport} />;
  }
  return <LibraryGridView {...gridProps} />;
}
