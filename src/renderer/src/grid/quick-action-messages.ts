import { defineMessages } from 'react-intl';

export const quickActionMessages = defineMessages({
  favoriteAdd: { id: 'library.quickActions.favorite.add', defaultMessage: 'Add to Favorites' },
  favoriteRemove: { id: 'library.quickActions.favorite.remove', defaultMessage: 'Remove from Favorites' },
  favoriteBusy: { id: 'library.quickActions.favorite.busy', defaultMessage: 'Favorite update in progress' },
  unavailableInTrash: { id: 'library.quickActions.unavailableInTrash', defaultMessage: 'Unavailable for photos in Trash' },
  availableOnlyInTrash: { id: 'library.quickActions.availableOnlyInTrash', defaultMessage: 'Available only for photos in Trash' },
  targetPhoto: { id: 'library.quickActions.target.photo', defaultMessage: 'This photo' },
  targetSelection: { id: 'library.quickActions.target.selection', defaultMessage: 'Selection ({count})' },
});
