import { useState, type ReactElement } from 'react';

import type { PageCursor } from '../../../shared/library/types.js';
import { useFormats } from '../i18n/use-formats.js';
import { useAppDispatch } from '../state/app-state-context';
import { PurgeConfirm } from './PurgeConfirm';

export function useEmptyTrash(): { readonly open: () => void; readonly dialog: ReactElement | null } {
  const { formatCount } = useFormats();
  const dispatch = useAppDispatch();
  const [selection, setSelection] = useState<{
    readonly ids: readonly string[];
    readonly excluded: number;
    readonly excluding: number;
  } | null>(null);

  const open = (): void => {
    void (async () => {
      const ids: string[] = [];
      let excluded = 0;
      let excluding = 0;
      let cursor: PageCursor | null | undefined;
      do {
        const page = await window.overlook.library.page({
          source: 'deleted',
          limit: 500,
          ...(cursor === undefined || cursor === null ? {} : { cursor }),
        });
        for (const photo of page.photos) {
          ids.push(photo.id);
          if (photo.coverage === 'excluded') excluded += 1;
          if (photo.coverage === 'excluding') excluding += 1;
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
      if (ids.length > 0) setSelection({ ids, excluded, excluding });
    })().catch(() => {
      dispatch({ type: 'toast/shown', toast: { title: "Couldn't load Trash contents", tone: 'red' } });
    });
  };

  const dialog =
    selection === null ? null : (
      <PurgeConfirm
        count={selection.ids.length}
        excludedCount={selection.excluded}
        excludingCount={selection.excluding}
        onCancel={() => setSelection(null)}
        onConfirm={() => {
          const confirmedIds = [...selection.ids];
          setSelection(null);
          void window.overlook.library.purge({ photoIds: confirmedIds }).then((outcome) => {
            if (outcome.status === 'cancelled') return;
            const { purged, protected: protectedCount, remoteFailures } = outcome.result;
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
