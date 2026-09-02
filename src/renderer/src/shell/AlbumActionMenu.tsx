import type { ReactElement } from 'react';
import { useIntl } from 'react-intl';

import type { AlbumListing } from '../../../shared/library/types.js';
import { commandById, formatShortcut, type CommandPlatform } from '../../../shared/commands/registry.js';
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu';
import type { AlbumReorderCommand } from './use-album-reorder';

export interface AlbumActionMenuProps {
  readonly album: AlbumListing;
  readonly x: number;
  readonly y: number;
  readonly onRename: () => void;
  readonly onDelete: () => void;
  readonly onTransfer?: (() => void) | undefined;
  /** Collection visibility toggle (#494, ADR-0030 §2). */
  readonly onSetVisibility: (showInAllPhotos: boolean) => void;
  /** Reaches an album that keeps this album's photos in All Photos (§2 disclosure). */
  readonly onOpenAlbum: (albumId: string) => void;
  readonly position: number;
  readonly total: number;
  readonly platform: CommandPlatform;
  readonly onReorder: (command: AlbumReorderCommand) => void;
  readonly onClose: () => void;
}

export function AlbumActionMenu({
  album,
  x,
  y,
  onRename,
  onDelete,
  onTransfer,
  onSetVisibility,
  onOpenAlbum,
  position,
  total,
  platform,
  onReorder,
  onClose,
}: AlbumActionMenuProps): ReactElement {
  const intl = useIntl();
  const alreadyFirst = intl.formatMessage({ id: 'album.reorder.alreadyFirstShort', defaultMessage: 'Already first' });
  const alreadyLast = intl.formatMessage({ id: 'album.reorder.alreadyLastShort', defaultMessage: 'Already last' });
  // ADR-0030 §2: inclusion wins, so the toggle discloses how many of this
  // album's photos stay in All Photos through another visible album and
  // offers to reach those albums.
  const disclosure =
    album.visibleElsewhere > 0
      ? intl.formatMessage(
          {
            id: 'album.visibility.elsewhere',
            defaultMessage: '{count, plural, one {# photo stays} other {# photos stay}} in All Photos via other albums',
          },
          { count: album.visibleElsewhere },
        )
      : undefined;
  const visibilityItems: ContextMenuItem[] = [
    {
      id: album.showInAllPhotos ? 'album.hide' : 'album.show',
      label: intl.formatMessage(commandById(album.showInAllPhotos ? 'album.hide' : 'album.show').label),
      icon: album.showInAllPhotos ? 'eye-off' : 'eye',
      action: () => onSetVisibility(!album.showInAllPhotos),
      detail: disclosure,
      separatorBefore: true,
    },
    ...(album.showInAllPhotos
      ? []
      : album.visibleVia.map((via): ContextMenuItem => ({
          id: `album.visibility.via.${via.id}`,
          label: intl.formatMessage({ id: 'album.visibility.open', defaultMessage: 'Open {album}' }, { album: via.name }),
          icon: 'album',
          action: () => onOpenAlbum(via.id),
        }))),
  ];
  return (
    <ContextMenu
      label={intl.formatMessage({ id: 'album.context.actions', defaultMessage: 'Actions for {album}' }, { album: album.name })}
      x={x}
      y={y}
      onClose={onClose}
      closeOnSelect={false}
      items={[
        {
          id: 'album.reorder.up',
          label: intl.formatMessage(commandById('album.reorder.up').label),
          icon: 'arrow-up',
          action: () => onReorder('album.reorder.up'),
          detail: formatShortcut(commandById('album.reorder.up'), platform),
          disabledReason: position === 0 ? alreadyFirst : undefined,
        },
        {
          id: 'album.reorder.down',
          label: intl.formatMessage(commandById('album.reorder.down').label),
          icon: 'arrow-down',
          action: () => onReorder('album.reorder.down'),
          detail: formatShortcut(commandById('album.reorder.down'), platform),
          disabledReason: position === total - 1 ? alreadyLast : undefined,
        },
        {
          id: 'album.reorder.top',
          label: intl.formatMessage(commandById('album.reorder.top').label),
          icon: 'chevrons-up',
          action: () => onReorder('album.reorder.top'),
          disabledReason: position === 0 ? alreadyFirst : undefined,
          separatorBefore: true,
        },
        {
          id: 'album.reorder.bottom',
          label: intl.formatMessage(commandById('album.reorder.bottom').label),
          icon: 'chevrons-down',
          action: () => onReorder('album.reorder.bottom'),
          disabledReason: position === total - 1 ? alreadyLast : undefined,
        },
        ...visibilityItems,
        {
          id: 'album.rename',
          label: intl.formatMessage(commandById('album.rename').label),
          icon: 'album',
          action: onRename,
          separatorBefore: true,
        },
        ...(onTransfer === undefined
          ? []
          : [
              {
                id: 'album.transfer',
                label: intl.formatMessage(commandById('album.transfer').label),
                icon: 'refresh-cw' as const,
                action: onTransfer,
              },
            ]),
        {
          id: 'album.delete',
          label: intl.formatMessage(commandById('album.delete').label),
          icon: 'trash-2',
          action: onDelete,
          danger: true,
          separatorBefore: true,
        },
      ]}
    />
  );
}
