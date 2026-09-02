import type { ReactElement, Ref } from 'react';
import { useIntl } from 'react-intl';

import { useFormats } from '../i18n/use-formats.js';
import { directionOf } from '../../../shared/i18n/locales.js';
import { Icon, type IconName } from '../components/Icon';
import { Tooltip } from '../components/Tooltip';
import type { AlbumReorderCommand } from './use-album-reorder';

export interface SideRowProps {
  readonly icon: IconName;
  readonly label: string;
  readonly count: number | null;
  readonly active?: boolean;
  readonly onClick?: ((origin: HTMLButtonElement) => void) | undefined;
  readonly collapsed?: boolean;
  readonly buttonRef?: Ref<HTMLButtonElement> | undefined;
  readonly onOpenActions?: ((position: { readonly x: number; readonly y: number }, origin: HTMLButtonElement) => void) | undefined;
  readonly statusLabel?: string | undefined;
  readonly positionLabel?: string | undefined;
  /** Album hidden from All Photos (#494): a badge that is part of the accessible name. */
  readonly hiddenLabel?: string | undefined;
  /** Folder disclosure (#505): the row toggles its children and exposes the state. */
  readonly expanded?: boolean | undefined;
  readonly onReorderShortcut?: ((command: Extract<AlbumReorderCommand, 'album.reorder.up' | 'album.reorder.down'>) => void) | undefined;
}

/** One navigation row of the sidebar (#80): sources, albums, folders, and
 * protected albums share it. Collapsed rows are icon-only with the hint as
 * their accessible name and an inline-end tooltip. */
export function SideRow({
  icon,
  label,
  count,
  active = false,
  onClick,
  collapsed = false,
  buttonRef,
  onOpenActions,
  statusLabel,
  positionLabel,
  hiddenLabel,
  expanded,
  onReorderShortcut,
}: SideRowProps): ReactElement {
  const direction = directionOf(useIntl().locale);
  const { formatCount } = useFormats();
  const detail = statusLabel ?? (count === null ? null : formatCount(count));
  const hint = [label, hiddenLabel, detail, positionLabel].filter((part) => part !== null && part !== undefined).join(' · ');
  const row = (
    <button
      ref={buttonRef}
      type="button"
      className={`ovl-siderow${active ? ' ovl-siderow--active' : ''}${collapsed ? ' ovl-siderow--collapsed' : ''}`}
      onClick={onClick === undefined ? undefined : (event) => onClick(event.currentTarget)}
      disabled={onClick === undefined}
      // Collapsed rows are icon-only; the hint is their accessible name.
      aria-label={collapsed ? hint : undefined}
      aria-haspopup={onOpenActions === undefined ? undefined : 'menu'}
      aria-expanded={expanded}
      onContextMenu={
        onOpenActions === undefined
          ? undefined
          : (event) => {
              event.preventDefault();
              onOpenActions({ x: event.clientX, y: event.clientY }, event.currentTarget);
            }
      }
      onKeyDown={
        onOpenActions === undefined && onReorderShortcut === undefined
          ? undefined
          : (event) => {
              if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && onReorderShortcut !== undefined) {
                event.preventDefault();
                onReorderShortcut(event.key === 'ArrowUp' ? 'album.reorder.up' : 'album.reorder.down');
                return;
              }
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                if (onOpenActions === undefined) return;
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                onOpenActions({ x: direction === 'rtl' ? bounds.left - 214 : bounds.right + 4, y: bounds.top }, event.currentTarget);
              }
            }
      }
    >
      <Icon name={icon} size={14} color={active ? 'var(--accent-cyan)' : 'var(--text-faint)'} />
      {collapsed ? null : <span className="ovl-siderow__label">{label}</span>}
      {collapsed || hiddenLabel === undefined ? null : (
        <span className="ovl-siderow__hidden" role="img" aria-label={hiddenLabel} title={hiddenLabel}>
          <Icon name="eye-off" size={12} />
        </span>
      )}
      {collapsed || detail === null ? null : (
        <span className={`ovl-siderow__count mono-data${statusLabel === undefined ? '' : ' ovl-siderow__count--status'}`}>{detail}</span>
      )}
    </button>
  );
  // The rail keeps every destination reachable: the hidden label (and count)
  // move into an inline-end tooltip, unclipped by the nav's own overflow.
  return collapsed ? (
    <Tooltip label={hint} side={direction === 'rtl' ? 'left' : 'right'}>
      {row}
    </Tooltip>
  ) : (
    row
  );
}
