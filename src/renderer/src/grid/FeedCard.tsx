import type { DragEvent, KeyboardEvent, ReactElement, ReactNode } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import './feed.css';
import type { PhotoRecord } from '../../../shared/library/types.js';
import { thumbUrl } from '../../../shared/library/thumb-url.js';
import { FavoriteButton } from '../components/FavoriteButton';
import { Icon, type IconName } from '../components/Icon';
import { PhotoOpenButton } from '../components/PhotoOpenButton';
import { StatusGlyph } from '../components/StatusGlyph';
import { previewFailureLabel } from '../components/previewFailureLabel';
import { useFormats } from '../i18n/use-formats.js';
import type { VideoTileProps } from '../media/device-capabilities.js';

export interface FeedCardProps {
  readonly photo: PhotoRecord;
  /** Thumb source override (stories); defaults to the #75 protocol URL. */
  readonly src?: string | undefined;
  /** Larger derivative that fades in over the thumb; defaults to the mid size. */
  readonly fullSrc?: string | undefined;
  /** Video/audio placeholder state (PhotoTile's contract): audio and
   * still-probing media show kind iconography instead of derivatives that do
   * not exist; a video shows its poster with the film glyph as fallback. */
  readonly media?: VideoTileProps | null | undefined;
  readonly selected: boolean;
  readonly accessibleName?: string | undefined;
  /** Opens the photo (card body). */
  readonly onOpen: () => void;
  /** Toggles selection (circle only) — never opens. */
  readonly onToggleSelect: (extend: boolean) => void;
  /** Toggles Favorite (star only) — never opens or selects. */
  readonly onToggleFavorite: () => void;
  readonly favoritePending?: boolean;
  readonly retentionLabel?: string | undefined;
  readonly onContextAction?: ((point: { readonly x: number; readonly y: number; readonly origin: HTMLButtonElement }) => void) | undefined;
  readonly quickActions?: ReactNode;
  readonly onQuickActionTargetChange?: ((active: boolean) => void) | undefined;
  readonly onDragStart?: ((event: DragEvent<HTMLButtonElement>) => void) | undefined;
  readonly onDragEnd?: (() => void) | undefined;
  readonly tabIndex?: 0 | -1 | undefined;
  readonly gridFocusTarget?: true | undefined;
  readonly onFocus?: (() => void) | undefined;
  readonly onKeyDown?: ((event: KeyboardEvent<HTMLButtonElement>) => void) | undefined;
}

const messages = defineMessages({
  moreActions: { id: 'library.photo.moreActions', defaultMessage: 'More actions for {photo}' },
  open: { id: 'feed.open', defaultMessage: 'Open {photo}' },
  select: { id: 'feed.select', defaultMessage: 'Select {photo}' },
  deselect: { id: 'feed.deselect', defaultMessage: 'Deselect {photo}' },
  protectedOriginal: { id: 'feed.protectedOriginal', defaultMessage: 'Protected Original' },
  noDescription: { id: 'feed.noDescription', defaultMessage: 'No description' },
});

/** Kind iconography for placeholder frames (design §Grid tiles). */
const PLACEHOLDER_ICON: Readonly<Record<'video' | 'audio' | 'probing', IconName>> = {
  video: 'film',
  audio: 'music',
  probing: 'loader',
};

// Progressive loading state lives on the frame's dataset, like PhotoTile's
// data-unavailable: the thumb (already cached from the grid) paints first and
// the larger derivative fades in on load; a failed derivative shows the
// preview-unavailable copy instead of a broken image — except for a video,
// whose missing poster is a success state shown as the film glyph.
function markFrame(image: HTMLImageElement, state: 'loaded' | 'unavailable' | 'fallback', label: string): void {
  const frame = image.parentElement;
  if (frame === null) return;
  frame.dataset['state'] = state;
  const fallback = frame.querySelector<HTMLElement>('.ovl-feedcard__unavailable');
  if (fallback !== null) fallback.textContent = state === 'unavailable' ? label : '';
}

// Feed card (#516): title, image, description in one reading-width column
// over the #74 engine. Same selection contract as ListRow — open and select
// are sibling buttons so both keep their native semantics.
export function FeedCard({
  photo,
  src,
  fullSrc,
  media,
  selected,
  accessibleName,
  onOpen,
  onToggleSelect,
  onToggleFavorite,
  favoritePending = false,
  retentionLabel,
  onContextAction,
  quickActions,
  onQuickActionTargetChange,
  onDragStart,
  onDragEnd,
  tabIndex,
  gridFocusTarget,
  onFocus,
  onKeyDown,
}: FeedCardProps): ReactElement {
  const intl = useIntl();
  const { formatCalendarDate } = useFormats();
  const photoName = (accessibleName ?? photo.fileName).replace(/^Open /u, '');
  const title = photo.title?.trim() ?? '';
  const description = photo.description?.trim() ?? '';
  const unavailableLabel = previewFailureLabel(intl, photo.previewFailure);
  // Without a title the file name stands in as the heading; with one, the
  // file name moves to the meta line so the photo stays identifiable.
  const meta =
    retentionLabel ??
    [title === '' ? null : photo.fileName, photo.takenAt === null ? null : formatCalendarDate(photo.takenAt), photo.place, photo.camera]
      .filter((part): part is string => part !== null && part !== '')
      .join(' · ');
  const openLabel = accessibleName ?? intl.formatMessage(messages.open, { photo: photo.fileName });
  const selectLabel = intl.formatMessage(selected ? messages.deselect : messages.select, { photo: photoName });
  const protectedLabel = intl.formatMessage(messages.protectedOriginal);
  const cardClass = [
    'ovl-feedcard',
    selected ? 'ovl-feedcard--selected' : null,
    photo.syncState === 'offloaded' ? 'ovl-feedcard--offloaded' : null,
  ]
    .filter(Boolean)
    .join(' ');
  const selectClass = selected ? 'ovl-feedcard__select ovl-feedcard__select--selected' : 'ovl-feedcard__select';
  const titleClass = title === '' ? 'ovl-feedcard__title ovl-feedcard__title--fallback' : 'ovl-feedcard__title';
  const descriptionClass = description === '' ? 'ovl-feedcard__description ovl-feedcard__description--empty' : 'ovl-feedcard__description';
  const thumbSource = src ?? thumbUrl(photo.id);
  const fullSource = fullSrc ?? thumbUrl(photo.id, 'mid');
  const placeholder = media?.placeholder ?? null;
  const placeholderClass =
    placeholder === 'probing' ? 'ovl-feedcard__placeholder ovl-feedcard__placeholder--probing' : 'ovl-feedcard__placeholder';
  const frame =
    placeholder !== null && placeholder !== 'video' ? (
      <div className="ovl-feedcard__frame" data-state="placeholder">
        <div className={placeholderClass}>
          <Icon name={PLACEHOLDER_ICON[placeholder]} size={40} strokeWidth={1.75} />
        </div>
      </div>
    ) : (
      <div key={fullSource} className="ovl-feedcard__frame" data-state="loading">
        <img src={thumbSource} alt="" draggable={false} className="ovl-feedcard__img ovl-feedcard__img--thumb" />
        <img
          src={fullSource}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="ovl-feedcard__img ovl-feedcard__img--full"
          onLoad={(event) => {
            markFrame(event.currentTarget, 'loaded', '');
          }}
          onError={(event) => {
            if (placeholder === 'video') markFrame(event.currentTarget, 'fallback', '');
            else markFrame(event.currentTarget, 'unavailable', unavailableLabel);
          }}
        />
        {placeholder === 'video' ? (
          <div className="ovl-feedcard__placeholder ovl-feedcard__placeholder--fallback">
            <Icon name={PLACEHOLDER_ICON.video} size={40} strokeWidth={1.75} />
          </div>
        ) : null}
        <div className="ovl-feedcard__unavailable mono-data" />
      </div>
    );
  return (
    <div
      role="group"
      className={cardClass}
      data-quick-action-photo-id={photo.id}
      onPointerEnter={() => onQuickActionTargetChange?.(true)}
      onPointerLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) onQuickActionTargetChange?.(false);
      }}
      onFocusCapture={() => onQuickActionTargetChange?.(true)}
      onBlurCapture={(event) => {
        if (
          (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) &&
          !event.currentTarget.matches(':hover')
        ) {
          onQuickActionTargetChange?.(false);
        }
      }}
    >
      <PhotoOpenButton
        label={openLabel}
        className="ovl-feedcard__open"
        onOpen={onOpen}
        onContextAction={onContextAction}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        tabIndex={tabIndex}
        gridFocusTarget={gridFocusTarget}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
      />
      <div className="ovl-feedcard__head">
        <button
          type="button"
          aria-label={selectLabel}
          aria-pressed={selected}
          className={selectClass}
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelect(event.shiftKey);
          }}
          onKeyDown={(event) => {
            if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() !== 'i') event.stopPropagation();
          }}
        >
          {selected ? <Icon name="check" size={11} strokeWidth={3} color="var(--text-on-accent)" /> : null}
        </button>
        <div className="ovl-feedcard__heading">
          <div className={titleClass} aria-hidden="true">
            {title === '' ? photo.fileName : title}
          </div>
          <div className="ovl-feedcard__meta mono-data">{meta}</div>
        </div>
        {photo.isOriginal ? (
          <span role="img" aria-label={protectedLabel} title={protectedLabel}>
            <Icon name="shield-check" size={15} color="var(--accent-amber)" />
          </span>
        ) : null}
        {quickActions}
        <FavoriteButton
          favorite={photo.favorite}
          pending={favoritePending}
          className="ovl-feedcard__favorite"
          onToggle={onToggleFavorite}
        />
        {onContextAction === undefined ? null : (
          <button
            type="button"
            className="ovl-feedcard__more"
            aria-label={intl.formatMessage(messages.moreActions, { photo: photoName })}
            aria-haspopup="menu"
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              onContextAction({ x: rect.right, y: rect.bottom, origin: event.currentTarget });
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Icon name="sliders-horizontal" size={14} />
          </button>
        )}
        <span className="ovl-feedcard__status">
          <StatusGlyph state={photo.syncState} size={16} />
        </span>
      </div>
      {frame}
      <p className={descriptionClass}>{description === '' ? intl.formatMessage(messages.noDescription) : description}</p>
    </div>
  );
}
