import type { CSSProperties, ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { directionOf } from '../../../shared/i18n/locales.js';
import type { AlbumListing } from '../../../shared/library/types.js';
import { Icon } from '../components/Icon';
import { Tooltip } from '../components/Tooltip';
import { SideRow } from './SideRow';
import type { useAlbumPhotoDrop } from './use-album-photo-drop';
import type { useAlbumReorder } from './use-album-reorder';

const messages = defineMessages({
  list: { id: 'sidebar.heading.albums', defaultMessage: 'Albums' },
  hiddenFromAllPhotos: { id: 'sidebar.album.hiddenFromAllPhotos', defaultMessage: 'Hidden from All Photos' },
  positionSuffix: { id: 'album.reorder.positionSuffix', defaultMessage: 'album {position} of {total}' },
  folderPositionSuffix: { id: 'album.folder.positionSuffix', defaultMessage: 'folder {position} of {total}' },
  reorderTooltip: { id: 'album.reorder.tooltip', defaultMessage: 'Reorder album' },
  actions: { id: 'sidebar.album.actions', defaultMessage: 'Actions for {name}' },
});

export interface AlbumTreeProps {
  readonly collapsed: boolean;
  readonly activeAlbumId: string | null;
  /** Per-profile view state (ADR-0030 §5): which folders show their children. */
  readonly isExpanded: (folderId: string) => boolean;
  readonly onToggleFolder: (folderId: string) => void;
  readonly onSelectAlbum: (albumId: string) => void;
  readonly onOpenActions: (album: AlbumListing, position: { readonly x: number; readonly y: number }, origin: HTMLElement) => void;
  readonly albumReorder: ReturnType<typeof useAlbumReorder<AlbumListing>>;
  readonly albumDrop: ReturnType<typeof useAlbumPhotoDrop>;
}

// The sidebar's collection tree (#505, ADR-0030 §1): one flat list in
// depth-first order — the order main already keeps — with each row indented
// by its depth. Rows under a collapsed folder are not rendered. Reordering
// stays among siblings (the hook enforces it); a folder carries its subtree.
export function AlbumTree({
  collapsed,
  activeAlbumId,
  isExpanded,
  onToggleFolder,
  onSelectAlbum,
  onOpenActions,
  albumReorder,
  albumDrop,
}: AlbumTreeProps): ReactElement {
  const intl = useIntl();
  const direction = directionOf(intl.locale);
  const byId = new Map(albumReorder.albums.map((album) => [album.id, album]));
  const depthOf = (album: AlbumListing): { depth: number; visible: boolean } => {
    let depth = 0;
    let visible = true;
    let parentId = album.parentId;
    const seen = new Set<string>();
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (parent === undefined) break;
      depth += 1;
      if (!isExpanded(parent.id)) visible = false;
      parentId = parent.parentId;
    }
    return { depth, visible };
  };
  return (
    <ul className="ovl-sidebar__albumlist" aria-label={intl.formatMessage(messages.list)}>
      {albumReorder.albums.map((album) => {
        const { depth, visible } = depthOf(album);
        if (!visible) return null;
        const folder = album.kind === 'folder';
        const expanded = folder ? isExpanded(album.id) : undefined;
        const { position, total } = albumReorder.placement(album.id);
        const photoDropProps = folder ? null : albumDrop.targetProps(album);
        const reorderRowProps = albumReorder.rowProps(album);
        const feedback = albumDrop.feedback?.albumId === album.id ? albumDrop.feedback : null;
        return (
          // A list item is intentionally the drop boundary; activation remains on its nested button.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- typed album/photo drop target
          <li
            className={`ovl-sidebar__albumrow${feedback === null ? '' : ` ovl-sidebar__albumrow--drop-${feedback.phase}`}${albumReorder.grabbedId === album.id ? ' ovl-sidebar__albumrow--grabbed' : ''}${albumReorder.draggingId === album.id ? ' ovl-sidebar__albumrow--dragging' : ''}`}
            key={album.id}
            data-kind={album.kind}
            data-depth={depth}
            style={{ '--ovl-album-depth': collapsed ? 0 : depth } as CSSProperties}
            onDragEnter={(event) => {
              reorderRowProps.onDragEnter(event);
              if (!event.isPropagationStopped()) photoDropProps?.onDragEnter(event);
            }}
            onDragOver={(event) => {
              reorderRowProps.onDragOver(event);
              if (!event.isPropagationStopped()) photoDropProps?.onDragOver(event);
            }}
            onDragLeave={photoDropProps?.onDragLeave}
            onDrop={(event) => {
              reorderRowProps.onDrop(event);
              if (!event.isPropagationStopped()) photoDropProps?.onDrop(event);
            }}
          >
            <SideRow
              icon={folder ? (expanded === true ? 'folder-open' : 'folder') : 'album'}
              label={album.name}
              count={album.count}
              active={activeAlbumId === album.id}
              collapsed={collapsed}
              expanded={expanded}
              positionLabel={
                collapsed
                  ? intl.formatMessage(folder ? messages.folderPositionSuffix : messages.positionSuffix, { position: position + 1, total })
                  : undefined
              }
              statusLabel={feedback?.label}
              hiddenLabel={album.showInAllPhotos ? undefined : intl.formatMessage(messages.hiddenFromAllPhotos)}
              onClick={() => {
                if (folder) onToggleFolder(album.id);
                else onSelectAlbum(album.id);
              }}
              onOpenActions={(menuPosition, origin) => onOpenActions(album, menuPosition, origin)}
              onReorderShortcut={(command) => albumReorder.moveByCommand(album, command)}
            />
            {collapsed ? null : (
              <Tooltip label={intl.formatMessage(messages.reorderTooltip)} side="right">
                <button type="button" className="ovl-sidebar__album-reorder" {...albumReorder.handleProps(album)}>
                  <Icon name="grip-vertical" size={15} />
                </button>
              </Tooltip>
            )}
            {collapsed ? null : (
              <button
                type="button"
                className="ovl-sidebar__album-actions"
                aria-label={intl.formatMessage(messages.actions, { name: album.name })}
                aria-haspopup="menu"
                tabIndex={-1}
                onClick={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  onOpenActions(
                    album,
                    { x: direction === 'rtl' ? bounds.left : bounds.right - 190, y: bounds.bottom + 4 },
                    event.currentTarget,
                  );
                }}
              >
                <Icon name="sliders-horizontal" size={12} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
