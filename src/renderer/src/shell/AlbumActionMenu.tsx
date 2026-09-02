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
  /** Follow the containing folder's policy again (#505, §2). */
  readonly onInheritVisibility?: (() => void) | undefined;
  /** Reaches an album that keeps this album's photos in All Photos (§2 disclosure). */
  readonly onOpenAlbum: (albumId: string) => void;
  /** Folder structure (#505): create inside a folder, move, tag. */
  readonly onNewAlbumInside?: (() => void) | undefined;
  readonly onNewFolderInside?: (() => void) | undefined;
  readonly onMove?: (() => void) | undefined;
  readonly onTags?: (() => void) | undefined;
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
  onInheritVisibility,
  onOpenAlbum,
  onNewAlbumInside,
  onNewFolderInside,
  onMove,
  onTags,
  position,
  total,
  platform,
  onReorder,
  onClose,
}: AlbumActionMenuProps): ReactElement {
  const intl = useIntl();
  const folder = album.kind === 'folder';
  const alreadyFirst = intl.formatMessage({ id: 'album.reorder.alreadyFirstShort', defaultMessage: 'Already first' });
  const alreadyLast = intl.formatMessage({ id: 'album.reorder.alreadyLastShort', defaultMessage: 'Already last' });
  // ADR-0030 §2: inclusion wins, so the toggle discloses how many of this
  // album's photos stay in All Photos through another visible album and
  // offers to reach those albums. A collection following its folder says so.
  const disclosure = album.inheritsVisibility
    ? intl.formatMessage({ id: 'album.visibility.inherited', defaultMessage: 'Follows the folder setting' })
    : album.visibleElsewhere > 0
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
    ...(onInheritVisibility === undefined || album.parentId === null || album.inheritsVisibility
      ? []
      : [
          {
            id: 'album.visibility.inherit',
            label: intl.formatMessage(commandById('album.visibility.inherit').label),
            icon: 'folder' as const,
            action: onInheritVisibility,
          },
        ]),
    ...(album.showInAllPhotos
      ? []
      : album.visibleVia.map((via): ContextMenuItem => ({
          id: `album.visibility.via.${via.id}`,
          label: intl.formatMessage({ id: 'album.visibility.open', defaultMessage: 'Open {album}' }, { album: via.name }),
          icon: 'album',
          action: () => onOpenAlbum(via.id),
        }))),
  ];
  const structureItems: ContextMenuItem[] = [
    ...(folder && onNewAlbumInside !== undefined
      ? [
          {
            id: 'album.folder.newAlbum',
            label: intl.formatMessage({ id: 'album.folder.newAlbum', defaultMessage: 'New album inside…' }),
            icon: 'album' as const,
            action: onNewAlbumInside,
            separatorBefore: true,
          },
        ]
      : []),
    ...(folder && onNewFolderInside !== undefined
      ? [
          {
            id: 'album.folder.new',
            label: intl.formatMessage({ id: 'album.folder.newInside', defaultMessage: 'New folder inside…' }),
            icon: 'folder' as const,
            action: onNewFolderInside,
            separatorBefore: onNewAlbumInside === undefined,
          },
        ]
      : []),
    ...(onMove === undefined
      ? []
      : [
          {
            id: 'album.move',
            label: intl.formatMessage(commandById('album.move').label),
            icon: 'folder-open' as const,
            action: onMove,
            separatorBefore: !folder,
          },
        ]),
    ...(onTags === undefined
      ? []
      : [
          {
            id: 'album.tags',
            label: intl.formatMessage(commandById('album.tags').label),
            icon: 'group' as const,
            action: onTags,
            detail: album.tags.length === 0 ? undefined : album.tags.join(', '),
          },
        ]),
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
        ...structureItems,
        ...visibilityItems,
        {
          id: 'album.rename',
          label: folder
            ? intl.formatMessage({ id: 'album.folder.rename', defaultMessage: 'Rename folder…' })
            : intl.formatMessage(commandById('album.rename').label),
          icon: folder ? 'folder' : 'album',
          action: onRename,
          separatorBefore: true,
        },
        ...(onTransfer === undefined || folder
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
          label: folder
            ? intl.formatMessage({ id: 'album.folder.delete', defaultMessage: 'Delete folder…' })
            : intl.formatMessage(commandById('album.delete').label),
          icon: 'trash-2',
          action: onDelete,
          danger: true,
          separatorBefore: true,
        },
      ]}
    />
  );
}
