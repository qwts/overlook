import type { ActivityFacade } from '../activity/activity-publication.js';
import { mutateWithActivity } from '../activity/activity-publication.js';
import { favoriteCommand } from '../history/command-drafts.js';
import type { LibraryService } from './library-service.js';

export function toggleFavoriteWithActivity(
  getService: () => LibraryService,
  getActivity: (() => ActivityFacade) | undefined,
  id: string,
): ReturnType<LibraryService['toggleFavorite']> {
  return mutateWithActivity(
    getActivity,
    () => getService().toggleFavorite(id),
    (result) => ({
      eventType: 'photo.favorite-changed',
      entityIds: [id],
      outcome: 'succeeded',
      payload: { favorite: result.favorite },
    }),
    (result) => favoriteCommand(id, result.favorite),
  );
}

export function toggleFavoritesWithActivity(
  getService: () => LibraryService,
  getActivity: (() => ActivityFacade) | undefined,
  photoIds: readonly string[],
): ReturnType<LibraryService['toggleFavorites']> {
  return mutateWithActivity(
    getActivity,
    () => getService().toggleFavorites(photoIds),
    (result) =>
      result.updated === 0
        ? undefined
        : {
            eventType: 'photo.favorite-changed',
            entityIds: result.changes.map(({ id }) => id),
            outcome: 'succeeded',
            payload: { count: result.updated },
          },
    (result) => result.changes.map(({ id, favorite }) => favoriteCommand(id, favorite)),
  );
}
