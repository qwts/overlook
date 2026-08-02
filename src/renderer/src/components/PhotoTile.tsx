import { Fragment, type DragEvent, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import './phototile.css';
import type { PreviewFailureReason } from '../../../shared/library/preview.js';
import { formatDuration } from '../../../shared/library/media-info-format.js';
import { FavoriteButton } from './FavoriteButton';
import { Icon, type IconName } from './Icon';
import { PhotoOpenButton } from './PhotoOpenButton';
import { previewFailureLabel } from './previewFailureLabel';
import { StatusGlyph, type SyncState } from './StatusGlyph';

export interface PhotoTileProps {
  /** Poster/thumbnail URL. Optional: placeholder tiles (video/audio/probing
   * with no decoded frame) render kind iconography instead of an image. */
  readonly src?: string;
  readonly alt?: string;
  /** Full screen-reader label when filename-only `alt` lacks date/place context. */
  readonly accessibleName?: string | undefined;
  readonly selected?: boolean;
  readonly favorite?: boolean;
  readonly isOriginal?: boolean;
  readonly status?: SyncState;
  readonly showStatus?: boolean;
  readonly previewFailure?: PreviewFailureReason | null;
  /** Video duration in seconds → the monospace duration pill (design §Grid
   * tiles). Null/undefined for stills. */
  readonly duration?: number | null | undefined;
  /** Preserved-only video: the pill reads "PRESERVED" with a film glyph
   * instead of a play time (ADR-0026 §3/§7). */
  readonly preserved?: boolean;
  /** Kind-iconography placeholder when no poster frame exists yet (a success
   * state, never a failed import): 'video' | 'audio' | 'probing'. */
  readonly placeholder?: 'video' | 'audio' | 'probing' | null | undefined;
  readonly retentionLabel?: string | undefined;
  /** Opens the photo (tile body). */
  readonly onClick?: () => void;
  /** Toggles selection (circle only) — never opens. */
  readonly onToggleSelect?: (extend: boolean) => void;
  /** Toggles Favorite (star only) — never opens or selects. */
  readonly onToggleFavorite?: () => void;
  readonly favoritePending?: boolean;
  readonly onContextAction?: ((point: { readonly x: number; readonly y: number; readonly origin: HTMLButtonElement }) => void) | undefined;
  readonly quickActions?: ReactNode;
  readonly quickActionPhotoId?: string | undefined;
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
  videoDurationTitle: { id: 'library.photo.video.durationTitle', defaultMessage: 'Video · {duration}' },
  videoTitle: { id: 'library.photo.video.title', defaultMessage: 'Video' },
  videoPreservedTitle: { id: 'library.photo.video.preservedTitle', defaultMessage: 'Video — preserved on this device' },
  videoPreservedPill: { id: 'library.photo.video.preservedPill', defaultMessage: 'PRESERVED' },
});

/** Kind iconography for placeholder tiles (design §Grid tiles). */
const PLACEHOLDER_ICON: Readonly<Record<'video' | 'audio' | 'probing', IconName>> = {
  video: 'film',
  audio: 'music',
  probing: 'loader',
};

function setPreviewUnavailable(image: HTMLImageElement, unavailable: boolean, label: string): void {
  // Toggling data-unavailable drives the CSS: the text overlay OR, for a
  // `video` placeholder, the film-glyph fallback. Only the text overlay carries
  // the label — writing textContent onto the film fallback would clobber its
  // icon and surface "PREVIEW UNAVAILABLE" on a perfectly good video tile.
  image.dataset['unavailable'] = unavailable ? 'true' : 'false';
  const fallback = image.nextElementSibling;
  if (!(fallback instanceof HTMLElement) || !fallback.classList.contains('ovl-tile__unavailable')) return;
  fallback.textContent = unavailable ? label : '';
  if (unavailable) fallback.setAttribute('role', 'status');
  else fallback.removeAttribute('role');
}

// media/PhotoTile.jsx — hover states ride CSS (:hover/:focus-within) instead
// of JS mouse tracking. Open and select are sibling buttons so both keep their
// native semantics in the accessibility tree.
export function PhotoTile({
  src,
  alt = '',
  accessibleName,
  selected = false,
  favorite = false,
  isOriginal = false,
  status = 'local',
  showStatus = true,
  previewFailure,
  duration,
  preserved = false,
  placeholder,
  retentionLabel,
  onClick,
  onToggleSelect,
  onToggleFavorite,
  favoritePending = false,
  onContextAction,
  quickActions,
  quickActionPhotoId,
  onQuickActionTargetChange,
  onDragStart,
  onDragEnd,
  tabIndex,
  gridFocusTarget,
  onFocus,
  onKeyDown,
}: PhotoTileProps): ReactElement {
  const intl = useIntl();
  const unavailableLabel = previewFailureLabel(intl, previewFailure);
  const photoName = (accessibleName ?? (alt === '' ? 'photo' : alt)).replace(/^Open /u, '');
  const classes = ['ovl-tile', selected ? 'ovl-tile--selected' : undefined, status === 'offloaded' ? 'ovl-tile--offloaded' : undefined]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      role="group"
      className={classes}
      data-quick-action-photo-id={quickActionPhotoId}
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
        label={accessibleName ?? (alt === '' ? 'Open photo' : `Open ${alt}`)}
        className="ovl-tile__open"
        onOpen={onClick}
        onContextAction={onContextAction}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        tabIndex={tabIndex}
        gridFocusTarget={gridFocusTarget}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
      />
      {placeholder && placeholder !== 'video' ? (
        <div className={`ovl-tile__placeholder${placeholder === 'probing' ? ' ovl-tile__placeholder--probing' : ''}`}>
          <Icon name={PLACEHOLDER_ICON[placeholder]} size={28} strokeWidth={1.75} />
        </div>
      ) : (
        // A `video` placeholder shows the deterministic poster once captured
        // (§6); until then the img is unavailable and the film-icon fallback
        // stands in — a success state, never the "PREVIEW UNAVAILABLE" text.
        <Fragment key={`${src}:${previewFailure ?? ''}:${placeholder ?? ''}`}>
          <img
            src={src}
            alt=""
            loading="lazy"
            draggable={false}
            className="ovl-tile__img"
            data-unavailable="false"
            onLoad={(event) => {
              setPreviewUnavailable(event.currentTarget, false, unavailableLabel);
            }}
            onError={(event) => {
              setPreviewUnavailable(event.currentTarget, true, unavailableLabel);
            }}
          />
          {placeholder === 'video' ? (
            <div className="ovl-tile__placeholder ovl-tile__placeholder--fallback">
              <Icon name="film" size={28} strokeWidth={1.75} />
            </div>
          ) : (
            <div className="ovl-tile__unavailable mono-data" />
          )}
        </Fragment>
      )}
      <div className="ovl-tile__hover-overlay" />
      {quickActions}
      {onToggleSelect === undefined ? null : (
        <button
          type="button"
          aria-label={`${selected ? 'Deselect' : 'Select'} ${photoName}`}
          aria-pressed={selected}
          className={`ovl-tile__select${selected ? ' ovl-tile__select--selected' : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelect(event.shiftKey);
          }}
          onKeyDown={(event) => {
            if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() !== 'i') event.stopPropagation();
          }}
        >
          {selected ? <Icon name="check" size={12} strokeWidth={3} /> : null}
        </button>
      )}
      {onToggleFavorite === undefined ? null : (
        <FavoriteButton favorite={favorite} pending={favoritePending} className="ovl-tile__favorite" onToggle={onToggleFavorite} />
      )}
      {onContextAction === undefined ? null : (
        <button
          type="button"
          className="ovl-tile__more"
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
      {showStatus && status !== 'local' ? (
        <span className="ovl-tile__status">
          <StatusGlyph state={status} size={18} />
        </span>
      ) : null}
      {isOriginal ? (
        <span className="ovl-tile__original" role="img" aria-label="Protected Original" title="Protected Original">
          <Icon name="shield-check" size={14} />
          <span>Original</span>
        </span>
      ) : null}
      {retentionLabel === undefined ? null : <span className="ovl-tile__retention mono-data">{retentionLabel}</span>}
      {duration == null && !preserved ? null : (
        <span
          className="ovl-tile__duration"
          title={
            preserved
              ? intl.formatMessage(messages.videoPreservedTitle)
              : duration == null
                ? intl.formatMessage(messages.videoTitle)
                : intl.formatMessage(messages.videoDurationTitle, { duration: formatDuration(duration) })
          }
        >
          <Icon name={preserved ? 'film' : 'play'} size={9} strokeWidth={2} />
          <span className="mono-data">
            {preserved ? intl.formatMessage(messages.videoPreservedPill) : duration == null ? '' : formatDuration(duration)}
          </span>
        </span>
      )}
    </div>
  );
}
