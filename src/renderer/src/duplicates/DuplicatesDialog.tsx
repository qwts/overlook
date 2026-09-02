import { useState, type Dispatch, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { AppAction } from '../../../shared/library/app-state.js';
import { closestPairFor, rotationOf, type DuplicateGroup } from '../../../shared/library/duplicate-groups.js';
import { FINGERPRINT_BITS } from '../../../shared/library/perceptual-hash.js';
import { thumbUrl } from '../../../shared/library/thumb-url.js';
import type { PhotoRecord } from '../../../shared/library/types.js';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { useFormats } from '../i18n/use-formats.js';
import { useDuplicateReview, type DuplicateReviewView } from './use-duplicate-review';

import './duplicates.css';

// Review Duplicates (#650): possible duplicates found by comparing each
// photo's own preview fingerprint, grouped with their evidence. Every action
// here is an ordinary one — Move to Trash routes through the library delete,
// so a marked Original is preserved and counted (#482) — and nothing merges
// records, shares encrypted blobs or changes custody. Intentional variants
// (#496) never appear as candidates.

const messages = defineMessages({
  title: { id: 'duplicates.title', defaultMessage: 'Review Duplicates' },
  loading: { id: 'duplicates.loading', defaultMessage: 'Loading…' },
  failed: { id: 'duplicates.failed', defaultMessage: 'Possible duplicates could not be loaded.' },
  progress: {
    id: 'duplicates.progress',
    defaultMessage: '{indexed} of {total} {total, plural, one {photo} other {photos}} compared · {pending} pending',
  },
  deferred: {
    id: 'duplicates.deferred',
    defaultMessage: '{deferred, plural, one {# photo has no preview to compare yet} other {# photos have no preview to compare yet}}',
  },
  rescan: { id: 'duplicates.rescan', defaultMessage: 'Rescan' },
  emptyIndexing: { id: 'duplicates.empty.indexing', defaultMessage: 'Still comparing previews — nothing to review yet.' },
  emptyClean: { id: 'duplicates.empty.clean', defaultMessage: 'No possible duplicates found.' },
  groups: { id: 'duplicates.groups', defaultMessage: '{count, plural, one {# group} other {# groups}}' },
  groupLabel: { id: 'duplicates.group.label', defaultMessage: 'Possible duplicates, {count} photos' },
  original: { id: 'duplicates.photo.original', defaultMessage: 'Original' },
  nearIdentical: { id: 'duplicates.evidence.nearIdentical', defaultMessage: 'Near-identical' },
  verySimilar: { id: 'duplicates.evidence.verySimilar', defaultMessage: 'Very similar' },
  similar: { id: 'duplicates.evidence.similar', defaultMessage: 'Similar' },
  rotated: { id: 'duplicates.evidence.rotated', defaultMessage: 'rotated {degrees}°' },
  distance: { id: 'duplicates.evidence.distance', defaultMessage: '{distance} of {bits} bits differ' },
  size: { id: 'duplicates.photo.size', defaultMessage: '{width}×{height}' },
  trash: { id: 'duplicates.photo.trash', defaultMessage: 'Move to Trash' },
  trashLabel: { id: 'duplicates.photo.trashLabel', defaultMessage: 'Move {name} to Trash' },
  protectedHint: { id: 'duplicates.photo.protected', defaultMessage: 'Protected Original — Shift+Delete in the library overrides' },
  trashed: { id: 'duplicates.toast.trashed', defaultMessage: 'Moved {name} to Trash' },
  preserved: { id: 'duplicates.toast.preserved', defaultMessage: 'Preserved {name}: protected Original' },
  missing: { id: 'duplicates.toast.missing', defaultMessage: '{name} is no longer in the library' },
  privacy: {
    id: 'duplicates.privacy',
    defaultMessage: 'Compared on this device from each photo’s own preview. Suggestions only: nothing is merged or deleted for you.',
  },
});

const TEST_ID = 'duplicates-dialog';

export interface DuplicatesDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly dispatch: Dispatch<AppAction>;
  /** Test/story seam; production resolves the preload bridge. */
  readonly api?: Pick<OverlookApi, 'duplicates' | 'library'> | undefined;
}

type ReviewGroup = DuplicateReviewView['groups'][number];

function evidenceFor(group: ReviewGroup, photoId: string): { readonly distance: number; readonly rotation: number } | null {
  const shape: DuplicateGroup = { id: group.id, photoIds: group.photos.map((photo) => photo.id), pairs: group.pairs };
  const pair = closestPairFor(shape, photoId);
  return pair === null ? null : { distance: pair.distance, rotation: rotationOf(pair, photoId) };
}

function GroupCard({
  group,
  busyId,
  onTrash,
}: {
  readonly group: ReviewGroup;
  readonly busyId: string | null;
  readonly onTrash: (photo: PhotoRecord) => void;
}): ReactElement {
  const intl = useIntl();
  const { formatBytes, formatCalendarDate } = useFormats();
  return (
    <section
      className="ovl-duplicates__group"
      data-testid="duplicate-group"
      data-group-id={group.id}
      data-count={group.photos.length}
      aria-label={intl.formatMessage(messages.groupLabel, { count: group.photos.length })}
    >
      <ul className="ovl-duplicates__photos">
        {group.photos.map((photo) => {
          const evidence = evidenceFor(group, photo.id);
          const strength =
            evidence === null
              ? null
              : intl.formatMessage(
                  evidence.distance <= 2 ? messages.nearIdentical : evidence.distance <= 6 ? messages.verySimilar : messages.similar,
                );
          const facts = [
            strength,
            evidence !== null && evidence.rotation !== 0 ? intl.formatMessage(messages.rotated, { degrees: evidence.rotation }) : null,
            evidence === null ? null : intl.formatMessage(messages.distance, { distance: evidence.distance, bits: FINGERPRINT_BITS }),
          ].filter((part) => part !== null);
          return (
            <li
              key={photo.id}
              className="ovl-duplicates__photo"
              data-testid="duplicate-photo"
              data-photo-id={photo.id}
              data-distance={evidence?.distance ?? ''}
              data-rotation={evidence?.rotation ?? ''}
            >
              <img className="ovl-duplicates__thumb" src={thumbUrl(photo.id)} alt="" />
              <div className="ovl-duplicates__text">
                <span className="ovl-duplicates__name">{photo.fileName}</span>
                <span className="ovl-duplicates__meta mono-data">
                  {[
                    intl.formatMessage(messages.size, { width: photo.width, height: photo.height }),
                    formatBytes(photo.bytes),
                    formatCalendarDate(photo.takenAt ?? photo.importedAt),
                  ].join(' · ')}
                </span>
                <span className="ovl-duplicates__evidence">{facts.join(' · ')}</span>
                {photo.isOriginal ? (
                  <Badge tone="cyan" icon="shield-check">
                    {intl.formatMessage(messages.original)}
                  </Badge>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="secondary"
                icon="trash-2"
                aria-label={intl.formatMessage(messages.trashLabel, { name: photo.fileName })}
                title={photo.isOriginal ? intl.formatMessage(messages.protectedHint) : undefined}
                disabled={photo.isOriginal || busyId !== null}
                onClick={() => onTrash(photo)}
              >
                {intl.formatMessage(messages.trash)}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function DuplicatesDialog({ open, onClose, dispatch, api }: DuplicatesDialogProps): ReactElement | null {
  const intl = useIntl();
  const { announce } = useAnnouncer();
  const { status, review, rescan } = useDuplicateReview(api?.duplicates);
  const [busyId, setBusyId] = useState<string | null>(null);
  const library = api?.library ?? window.overlook.library;

  const trash = async (photo: PhotoRecord): Promise<void> => {
    setBusyId(photo.id);
    try {
      const result = await library.delete({ photoIds: [photo.id] });
      const title = intl.formatMessage(
        result.deleted > 0 ? messages.trashed : result.protected > 0 ? messages.preserved : messages.missing,
        { name: photo.fileName },
      );
      dispatch({ type: 'toast/shown', toast: { title, tone: result.deleted > 0 ? 'neutral' : 'amber' } });
      announce(title, 'polite', TEST_ID);
    } finally {
      setBusyId(null);
    }
  };

  const groups = review?.groups ?? [];
  const indexing = review !== null && review.status.pending > 0;
  const state = status === 'ready' ? (indexing ? 'indexing' : 'ready') : status;
  return (
    <Dialog open={open} title={intl.formatMessage(messages.title)} icon="copy" width={640} onClose={onClose} bodyClassName="ovl-duplicates">
      <div
        className="ovl-duplicates__body"
        data-testid={TEST_ID}
        data-state={state}
        data-groups={groups.length}
        data-pending={review?.status.pending ?? ''}
        data-indexed={review?.status.indexed ?? ''}
      >
        {status === 'failed' ? <p className="ovl-duplicates__state">{intl.formatMessage(messages.failed)}</p> : null}
        {status === 'loading' && review === null ? <p className="ovl-duplicates__state">{intl.formatMessage(messages.loading)}</p> : null}
        {review === null ? null : (
          <>
            <div className="ovl-duplicates__status">
              <span className="ovl-duplicates__progress mono-data" data-testid="duplicates-progress">
                {intl.formatMessage(messages.progress, {
                  indexed: review.status.indexed,
                  total: review.status.total,
                  pending: review.status.pending,
                })}
              </span>
              <Badge tone={groups.length === 0 ? 'neutral' : 'amber'} icon="copy">
                {intl.formatMessage(messages.groups, { count: groups.length })}
              </Badge>
              <Button size="sm" variant="ghost" icon="rotate-cw" onClick={() => void rescan()}>
                {intl.formatMessage(messages.rescan)}
              </Button>
            </div>
            {review.status.deferred > 0 ? (
              <p className="ovl-duplicates__note">{intl.formatMessage(messages.deferred, { deferred: review.status.deferred })}</p>
            ) : null}
            {groups.length === 0 ? (
              <p className="ovl-duplicates__state">{intl.formatMessage(indexing ? messages.emptyIndexing : messages.emptyClean)}</p>
            ) : (
              groups.map((group) => <GroupCard key={group.id} group={group} busyId={busyId} onTrash={(photo) => void trash(photo)} />)
            )}
            <p className="ovl-duplicates__privacy">{intl.formatMessage(messages.privacy)}</p>
          </>
        )}
      </div>
    </Dialog>
  );
}
