import type { ComponentProps, ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { AlbumListing } from '../../../shared/library/types.js';
import { Icon } from '../components/Icon';
import { LibraryGridView } from '../grid/LibraryGridView';
import { MoodboardRoute } from '../moodboard/MoodboardRoute';
import { useAppState } from '../state/app-state-context';
import type { Board } from '../../../shared/moodboard/board.js';
import type { PlacementAvailability } from '../../../shared/moodboard/availability.js';

// The primary (non-protected) library content router (#693): the Moodboard
// canvas when the board view is active, otherwise the grid/list view. Keeps the
// Shell's content branch to a single element.
const messages = defineMessages({
  unsupportedTitle: { id: 'smartAlbum.unsupported.title', defaultMessage: '{name} cannot be shown' },
  unsupportedHint: {
    id: 'smartAlbum.unsupported.hint',
    defaultMessage: 'Its saved query is kept exactly as it was. Choose facets and save to replace it, or open it in a newer version.',
  },
});

export function PrimaryLibraryView(
  props: ComponentProps<typeof LibraryGridView> & {
    readonly onBoardExport: (request: {
      readonly board: Board;
      readonly availability: Readonly<Record<string, PlacementAvailability>>;
    }) => void;
    /** The open Smart Album (#514); one this version cannot evaluate fails closed here. */
    readonly activeSmartAlbum: AlbumListing | null;
  },
): ReactElement {
  const intl = useIntl();
  const state = useAppState();
  const { onBoardExport, activeSmartAlbum, ...gridProps } = props;
  if (activeSmartAlbum?.unsupported !== null && activeSmartAlbum?.unsupported !== undefined && state.facets.groups.length === 0) {
    return (
      <div className="ovl-empty" data-testid="smart-album-unsupported" role="status">
        <Icon name="funnel" size={28} color="var(--text-faint)" />
        <div className="ovl-empty__title">{intl.formatMessage(messages.unsupportedTitle, { name: activeSmartAlbum.name })}</div>
        <div className="ovl-empty__hint">{activeSmartAlbum.unsupported}</div>
        <div className="ovl-empty__hint">{intl.formatMessage(messages.unsupportedHint)}</div>
      </div>
    );
  }
  if (state.view === 'moodboard') {
    return <MoodboardRoute photos={state.photos} onExport={onBoardExport} />;
  }
  return <LibraryGridView {...gridProps} />;
}
