import type { ReactElement } from 'react';
import { useIntl } from 'react-intl';

import { commandById, type CommandId, type QuickActionCommandId } from '../../../shared/commands/registry.js';
import type { PhotoRecord } from '../../../shared/library/types.js';
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu';
import type { IconName } from '../components/Icon';
import type { QuickActionItem } from './QuickActions';

export interface PhotoContextMenuProps {
  readonly photo: PhotoRecord;
  readonly targetCount: number;
  readonly inAlbum: boolean;
  readonly x: number;
  readonly y: number;
  readonly onOpen: () => void;
  readonly onToggleFavorite: () => void;
  readonly onSetOriginal: (isOriginal: boolean) => void;
  readonly onExport: () => void;
  readonly onDuplicate: () => void;
  readonly onAddToAlbum: () => void;
  readonly onRemoveFromAlbum: () => void;
  readonly onOffload: () => void;
  readonly onRestoreOriginal: () => void;
  readonly onTransfer?: (() => void) | undefined;
  readonly onTrash: () => void;
  readonly onRestore: () => void;
  readonly onPurge: () => void;
  readonly onClose: () => void;
  readonly quickActions?: readonly QuickActionItem[];
  readonly onQuickAction?: ((id: QuickActionCommandId) => void) | undefined;
}

export function PhotoContextMenu({
  photo,
  targetCount,
  inAlbum,
  x,
  y,
  onOpen,
  onToggleFavorite,
  onSetOriginal,
  onExport,
  onDuplicate,
  onAddToAlbum,
  onRemoveFromAlbum,
  onOffload,
  onRestoreOriginal,
  onTransfer,
  onTrash,
  onRestore,
  onPurge,
  onClose,
  quickActions = [],
  onQuickAction,
}: PhotoContextMenuProps): ReactElement {
  const intl = useIntl();
  const item = (
    id: CommandId,
    icon: IconName,
    action: () => void,
    options?: Pick<ContextMenuItem, 'danger' | 'separatorBefore'>,
  ): ContextMenuItem => ({ id, label: intl.formatMessage(commandById(id).label), icon, action, ...options });
  const quickActionIds = new Set<CommandId>(quickActions.map(({ id }) => id));
  const quickActionItems: readonly ContextMenuItem[] = quickActions.map((quickAction) => ({
    id: quickAction.id,
    label: quickAction.label,
    icon: quickAction.icon,
    action: () => onQuickAction?.(quickAction.id),
    detail: quickAction.reason ?? quickAction.targetLabel,
    disabledReason: quickAction.enabled ? undefined : (quickAction.reason ?? 'Unavailable'),
    danger: quickAction.id === 'photo.trash',
    separatorBefore: quickAction.id === 'photo.trash',
  }));
  const libraryQuickActionItems = quickActionItems.filter(({ id }) => id !== 'photo.trash');
  const trashQuickActionItem = quickActionItems.find(({ id }) => id === 'photo.trash');
  const inTrash = photo.deletedAt !== null;
  const items: readonly ContextMenuItem[] = inTrash
    ? [
        ...quickActionItems,
        ...(quickActionIds.has('photo.restore') ? [] : [item('photo.restore', 'rotate-ccw', onRestore)]),
        item('photo.purge', 'trash-2', onPurge, { danger: true, separatorBefore: true }),
      ]
    : [
        item('photo.open', 'image', onOpen),
        ...libraryQuickActionItems,
        ...(quickActionIds.has('photo.favorite.toggle') ? [] : [item('photo.favorite.toggle', 'star', onToggleFavorite)]),
        photo.isOriginal
          ? item('photo.original.unmark', 'shield-check', () => onSetOriginal(false))
          : item('photo.original.mark', 'shield-check', () => onSetOriginal(true)),
        ...(quickActionIds.has('photo.export') ? [] : [item('photo.export', 'share', onExport)]),
        item('photo.duplicate', 'copy', onDuplicate),
        ...(quickActionIds.has('album.membership.add') ? [] : [item('album.membership.add', 'album', onAddToAlbum)]),
        ...(inAlbum ? [item('album.membership.remove', 'x', onRemoveFromAlbum)] : []),
        photo.syncState === 'offloaded'
          ? item('photo.restoreOriginal', 'cloud-download', onRestoreOriginal)
          : item('photo.offload', 'cloud-upload', onOffload),
        ...(onTransfer === undefined ? [] : [item('photo.transfer', 'refresh-cw', onTransfer)]),
        ...(trashQuickActionItem === undefined
          ? [item('photo.trash', 'trash-2', onTrash, { danger: true, separatorBefore: true })]
          : [trashQuickActionItem]),
      ];
  return (
    <ContextMenu
      label={intl.formatMessage(
        { id: 'photo.context.actions', defaultMessage: 'Actions for {target}' },
        { target: targetCount === 1 ? photo.fileName : `${targetCount} selected photos` },
      )}
      x={x}
      y={y}
      items={items}
      onClose={onClose}
    />
  );
}
