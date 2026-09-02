import type { DragEvent, KeyboardEvent, ReactElement, ReactNode } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import './list.css';
import type { PhotoRecord } from '../../../shared/library/types.js';
import { thumbUrl } from '../../../shared/library/thumb-url.js';
import { Icon } from '../components/Icon';
import { FavoriteButton } from '../components/FavoriteButton';
import { PhotoOpenButton } from '../components/PhotoOpenButton';
import { StatusGlyph } from '../components/StatusGlyph';
import { useFormats } from '../i18n/use-formats.js';

export interface ListRowProps {
  readonly photo: PhotoRecord;
  /** Thumb source override (stories); defaults to the #75 protocol URL. */
  readonly src?: string | undefined;
  readonly selected: boolean;
  readonly accessibleName?: string | undefined;
  /** Opens the photo (row body). */
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
  locked: { id: 'library.photo.locked', defaultMessage: 'Locked — this device lacks its encryption key' },
});

// Dense 52px row (#77) — the mock's ListRow: same selection contract as
// PhotoTile. Open and select are sibling buttons so both keep their native
// semantics in the accessibility tree.
export function ListRow({
  photo,
  src,
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
}: ListRowProps): ReactElement {
  const { formatBytes, formatCalendarDate } = useFormats();
  const intl = useIntl();
  const photoName = (accessibleName ?? photo.fileName).replace(/^Open /u, '');
  return (
    <div
      role="group"
      className={`ovl-listrow${selected ? ' ovl-listrow--selected' : ''}`}
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
        label={accessibleName ?? `Open ${photo.fileName}`}
        className="ovl-listrow__open"
        onOpen={onOpen}
        onContextAction={onContextAction}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        tabIndex={tabIndex}
        gridFocusTarget={gridFocusTarget}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        aria-label={`${selected ? 'Deselect' : 'Select'} ${photoName}`}
        aria-pressed={selected}
        className={`ovl-listrow__select${selected ? ' ovl-listrow__select--selected' : ''}`}
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
      <div className="ovl-listrow__thumb">
        {photo.locked ? (
          <div
            className="ovl-listrow__img ovl-listrow__img--locked"
            role="img"
            aria-label={intl.formatMessage(messages.locked)}
            title={intl.formatMessage(messages.locked)}
          >
            <Icon name="lock" size={16} strokeWidth={1.75} />
          </div>
        ) : (
          <img
            src={src ?? thumbUrl(photo.id)}
            alt=""
            loading="lazy"
            draggable={false}
            className={`ovl-listrow__img${photo.syncState === 'offloaded' ? ' ovl-listrow__img--offloaded' : ''}`}
          />
        )}
      </div>
      <div className="ovl-listrow__main">
        <div className="ovl-listrow__name" aria-hidden="true">
          {photo.fileName}
        </div>
        <div className="ovl-listrow__meta mono-data">
          {retentionLabel ?? `${photo.place ?? '—'} · ${photo.takenAt === null ? '—' : formatCalendarDate(photo.takenAt)}`}
        </div>
      </div>
      {photo.isOriginal ? (
        <span role="img" aria-label="Protected Original" title="Protected Original">
          <Icon name="shield-check" size={15} color="var(--accent-amber)" />
        </span>
      ) : null}
      {quickActions}
      <div className="ovl-listrow__camera mono-data">{photo.camera ?? '—'}</div>
      <div className="ovl-listrow__size mono-data">{formatBytes(photo.bytes)}</div>
      <FavoriteButton favorite={photo.favorite} pending={favoritePending} className="ovl-listrow__favorite" onToggle={onToggleFavorite} />
      {onContextAction === undefined ? null : (
        <button
          type="button"
          className="ovl-listrow__more"
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
      <span className="ovl-listrow__status">
        <StatusGlyph state={photo.syncState} size={16} />
      </span>
    </div>
  );
}
