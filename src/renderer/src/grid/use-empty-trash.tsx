import { useState, type ReactElement } from 'react';

import type { PageCursor } from '../../../shared/library/types.js';
import { useFormats } from '../i18n/use-formats.js';
import { useAppDispatch } from '../state/app-state-context';
import { PurgeConfirm } from './PurgeConfirm';

export function useEmptyTrash(): { readonly open: () => void; readonly dialog: ReactElement | null } {
  const { formatCount } = useFormats();
  const dispatch = useAppDispatch();
  const [photoIds, setPhotoIds] = useState<readonly string[] | null>(null);

  const open = (): void => {
    void (async () => {
      const ids: string[] = [];
      let cursor: PageCursor | null | undefined;
      do {
        const page = await window.overlook.library.page({
          source: 'deleted',
          limit: 500,
          ...(cursor === undefined || cursor === null ? {} : { cursor }),
        });
        ids.push(...page.photos.map(({ id }) => id));
        cursor = page.nextCursor;
      } while (cursor !== null);
      if (ids.length > 0) setPhotoIds(ids);
    })().catch(() => {
      dispatch({ type: 'toast/shown', toast: { title: "Couldn't load Trash contents", tone: 'red' } });
    });
  };

  const dialog =
    photoIds === null ? null : (
      <PurgeConfirm
        count={photoIds.length}
        onCancel={() => setPhotoIds(null)}
        onConfirm={() => {
          const confirmedIds = [...photoIds];
          setPhotoIds(null);
          void window.overlook.library
            .purge({ photoIds: confirmedIds })
            .then(({ purged, protected: protectedCount, remoteFailures }) => {
              if (purged === 0 && protectedCount === 0 && remoteFailures === 0) return;
              dispatch({
                type: 'toast/shown',
                toast: {
                  title:
                    protectedCount > 0
                      ? `Deleted ${formatCount(purged)} permanently · preserved ${formatCount(protectedCount)} protected ${protectedCount === 1 ? 'Original' : 'Originals'}`
                      : remoteFailures === 0
                        ? `Deleted ${formatCount(purged)} ${purged === 1 ? 'photo' : 'photos'} permanently`
                        : `Deleted permanently: ${formatCount(purged)} local; ${formatCount(remoteFailures)} cloud pending retry`,
                  tone: remoteFailures === 0 && protectedCount === 0 ? 'neutral' : 'amber',
                },
              });
            });
        }}
      />
    );
  return { open, dialog };
}
