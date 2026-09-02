import { useEffect, useRef, useState } from 'react';
import type { ReactElement, Ref } from 'react';
import { FormattedMessage, defineMessages, useIntl } from 'react-intl';
import type { MessageDescriptor } from 'react-intl';

import { useFormats } from '../i18n/use-formats.js';
import { directionOf } from '../../../shared/i18n/locales.js';
import type { AlbumSummary, LibraryStats, SourceCounts, SourceFilter } from '../../../shared/library/types.js';
import { Icon, type IconName } from '../components/Icon';
import { ProgressBar } from '../components/ProgressBar';
import { Tooltip } from '../components/Tooltip';
import { useAppState, useAppDispatch } from '../state/app-state-context';
import { AlbumActionMenu } from './AlbumActionMenu';
import { DeleteAlbumDialog, RenameAlbumDialog } from './AlbumDialogs';
import { AlbumDropDialog } from './AlbumDropDialog';
import { useAlbumPhotoDrop } from './use-album-photo-drop';
import { ContextMenu } from '../components/ContextMenu';
import { commandById } from '../../../shared/commands/registry.js';
import type { CommandPlatform } from '../../../shared/commands/registry.js';
import { useAlbumReorder, type AlbumReorderCommand } from './use-album-reorder';

// The shell stylesheet carries the sidebar/rail rules; importing it here
// (not just in Shell) keeps the component styled when mounted alone, e.g.
// by its stories (PR #245).
import './shell.css';

const messages = defineMessages({
  nav: { id: 'sidebar.nav', defaultMessage: 'Library' },
  headingLibrary: { id: 'sidebar.heading.library', defaultMessage: 'Library' },
  headingAlbums: { id: 'sidebar.heading.albums', defaultMessage: 'Albums' },
  headingProtected: { id: 'sidebar.heading.protected', defaultMessage: 'Protected' },
  expand: { id: 'sidebar.expand', defaultMessage: 'Expand sidebar' },
  collapse: { id: 'sidebar.collapse', defaultMessage: 'Collapse sidebar' },
  newAlbum: { id: 'sidebar.album.new', defaultMessage: 'New album' },
  albumName: { id: 'sidebar.album.name', defaultMessage: 'Album name' },
  settings: { id: 'sidebar.settings', defaultMessage: 'Settings' },
  encrypted: { id: 'sidebar.encrypted', defaultMessage: 'Library encrypted' },
  encryptedOpenSettings: { id: 'sidebar.encrypted.openSettings', defaultMessage: 'Library encrypted — open Settings' },
  storageOnDisk: { id: 'sidebar.storage.onDisk', defaultMessage: '{bytes} on disk' },
  storageOffload: { id: 'sidebar.storage.offload', defaultMessage: '{bytes} offload ({provider})' },
  connect: { id: 'sidebar.connect', defaultMessage: 'Connect' },
  sourceAll: { id: 'sidebar.source.all', defaultMessage: 'All Photos' },
  sourceFavorites: { id: 'sidebar.source.favorites', defaultMessage: 'Favorites' },
  sourceRecent: { id: 'sidebar.source.recent', defaultMessage: 'Recent imports' },
  sourceOffloaded: { id: 'sidebar.source.offloaded', defaultMessage: 'Offloaded' },
  sourceDeleted: { id: 'sidebar.source.deleted', defaultMessage: 'Trash' },
});

const SOURCES: readonly { key: SourceFilter; icon: IconName; label: MessageDescriptor }[] = [
  { key: 'all', icon: 'images', label: messages.sourceAll },
  { key: 'favorites', icon: 'star', label: messages.sourceFavorites },
  { key: 'recent', icon: 'download', label: messages.sourceRecent },
  { key: 'offloaded', icon: 'cloud', label: messages.sourceOffloaded },
  { key: 'deleted', icon: 'trash-2', label: messages.sourceDeleted },
];

// Collapsed state persists across launches under the mock's own key (#238).
const COLLAPSE_KEY = 'overlook.sidebarCollapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

interface SideRowProps {
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
  readonly onReorderShortcut?: ((command: Extract<AlbumReorderCommand, 'album.reorder.up' | 'album.reorder.down'>) => void) | undefined;
}

function SideRow({
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
  onReorderShortcut,
}: SideRowProps): ReactElement {
  const direction = directionOf(useIntl().locale);
  const { formatCount } = useFormats();
  const detail = statusLabel ?? (count === null ? null : formatCount(count));
  const hint = [label, detail, positionLabel].filter((part) => part !== null && part !== undefined).join(' · ');
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

export interface SidebarProps {
  readonly platform: CommandPlatform;
  readonly counts: SourceCounts | null;
  readonly stats: LibraryStats | null;
  readonly albums: readonly AlbumSummary[];
  readonly onTransferAlbum?: ((album: AlbumSummary) => void) | undefined;
  readonly protectedAlbums?: readonly {
    readonly id: string;
    readonly label: string;
    readonly locked: boolean;
    readonly name?: string | undefined;
    readonly count?: number | undefined;
  }[];
  readonly onProtectedOpen?: ((albumId: string, origin: HTMLButtonElement) => void) | undefined;
  readonly onEmptyTrash?: (() => void) | undefined;
}

// The 216px navigation rail (#80) per the design's Sidebar.jsx. Album
// creation and management are keyboard-accessible here; the backup card
// shows the encrypted badge, the settings gear (opens the M09 dialog), a
// live aggregate bar while a backup runs (#108), and the mono storage line.
export function Sidebar({
  platform,
  counts,
  stats,
  albums,
  onTransferAlbum,
  protectedAlbums = [],
  onProtectedOpen,
  onEmptyTrash,
}: SidebarProps): ReactElement {
  const intl = useIntl();
  const direction = directionOf(intl.locale);
  const inlineEndSide = direction === 'rtl' ? 'left' : 'right';
  const { formatBytes, formatCount } = useFormats();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const albumDrop = useAlbumPhotoDrop(albums);
  const albumReorder = useAlbumReorder(albums);
  // Collapse to the 56px icon rail (#238): labels/counts move to tooltips,
  // headings become dividers, the backup card becomes the shield button.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [sourceMenu, setSourceMenu] = useState<{ readonly x: number; readonly y: number; readonly origin: HTMLButtonElement } | null>(null);
  const toggleCollapsed = (): void => {
    const next = !collapsed;
    try {
      window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    } catch {
      // Persistence is best-effort; the in-session toggle still works.
    }
    setCollapsed(next);
  };
  // The card's aggregate bar rides backup:progress (#108); it hides again
  // when the run finishes (done === total).
  const [backupRun, setBackupRun] = useState<{ done: number; total: number } | null>(null);
  // Inline album creation (#117) — the design gives the + affordance but no
  // flow; an inline name row keeps it keyboard-first (Enter/Escape).
  const [namingAlbum, setNamingAlbum] = useState(false);
  const [albumMenu, setAlbumMenu] = useState<{ readonly album: AlbumSummary; readonly x: number; readonly y: number } | null>(null);
  const [renamingAlbum, setRenamingAlbum] = useState<AlbumSummary | null>(null);
  const [deletingAlbum, setDeletingAlbum] = useState<AlbumSummary | null>(null);
  const allPhotosRef = useRef<HTMLButtonElement>(null);
  const albumActionOriginRef = useRef<HTMLElement | null>(null);
  const restoreAlbumActionFocus = (fallback: HTMLElement | null = allPhotosRef.current): void => {
    const origin = albumActionOriginRef.current;
    albumActionOriginRef.current = null;
    requestAnimationFrame(() => {
      (origin?.isConnected === true ? origin : fallback)?.focus();
    });
  };
  useEffect(() => {
    const offProgress = window.overlook.backup.onProgress(({ done, total }) => {
      setBackupRun(total === 0 ? null : { done, total });
    });
    // Early exits (auth/quota) break before a final done===total event —
    // completion always clears the bar (PR #207 review).
    const offCompleted = window.overlook.backup.onCompleted(() => {
      setBackupRun(null);
    });
    return () => {
      offProgress();
      offCompleted();
    };
  }, []);
  return (
    <nav
      className={`ovl-sidebar${collapsed ? ' ovl-sidebar--collapsed' : ''}${albumReorder.invalid ? ' ovl-sidebar--reorder-invalid' : ''}`}
      aria-label={intl.formatMessage(messages.nav)}
      {...albumReorder.invalidZoneProps}
    >
      <div className="ovl-sidebar__toggle-row">
        <Tooltip label={intl.formatMessage(collapsed ? messages.expand : messages.collapse)} side={inlineEndSide}>
          <button
            type="button"
            className="ovl-sidebar__toggle"
            aria-label={intl.formatMessage(collapsed ? messages.expand : messages.collapse)}
            aria-expanded={!collapsed}
            onClick={toggleCollapsed}
          >
            <Icon name={collapsed ? 'panel-left-open' : 'panel-left-close'} size={15} />
          </button>
        </Tooltip>
      </div>
      {collapsed ? (
        <div className="ovl-sidebar__divider" role="presentation" />
      ) : (
        <div className="ovl-sidebar__heading mono-data">
          <h2 className="ovl-sidebar__headingText">
            <FormattedMessage id="sidebar.heading.library" defaultMessage="Library" />
          </h2>
        </div>
      )}
      {SOURCES.filter(
        // Offloaded only earns its row once something is actually offloaded
        // (#268) — no in-app flow drives offload yet, so an always-empty
        // destination reads as broken. Unknown counts keep it hidden too;
        // it appears the moment real rows exist.
        ({ key }) => key !== 'offloaded' || (counts !== null && counts.offloaded > 0),
      ).map(({ key, icon, label }) => (
        <SideRow
          key={key}
          icon={icon}
          label={intl.formatMessage(label)}
          count={counts === null ? null : counts[key]}
          active={state.album === null && state.source === key}
          collapsed={collapsed}
          buttonRef={key === 'all' ? allPhotosRef : undefined}
          onClick={() => {
            dispatch({ type: 'source/set', source: key });
          }}
          onOpenActions={
            key === 'deleted' && onEmptyTrash !== undefined && (counts?.deleted ?? 0) > 0
              ? (position, origin) => setSourceMenu({ ...position, origin })
              : undefined
          }
        />
      ))}
      {sourceMenu === null ? null : (
        <ContextMenu
          label={intl.formatMessage({ id: 'sidebar.trash.actions', defaultMessage: 'Trash actions' })}
          x={sourceMenu.x}
          y={sourceMenu.y}
          items={[
            {
              id: 'trash.empty',
              label: intl.formatMessage(commandById('trash.empty').label),
              icon: 'trash-2',
              action: onEmptyTrash ?? (() => undefined),
              danger: true,
            },
          ]}
          onClose={() => {
            const origin = sourceMenu.origin;
            setSourceMenu(null);
            requestAnimationFrame(() => {
              if (origin.isConnected) origin.focus();
            });
          }}
        />
      )}
      {collapsed ? (
        <div className="ovl-sidebar__divider" role="presentation" />
      ) : (
        <div className="ovl-sidebar__heading mono-data">
          <h2 className="ovl-sidebar__headingText">
            <FormattedMessage id="sidebar.heading.albums" defaultMessage="Albums" />
          </h2>
          <button
            type="button"
            className="ovl-sidebar__gear"
            aria-label={intl.formatMessage(messages.newAlbum)}
            onClick={() => {
              setNamingAlbum(true);
            }}
          >
            <Icon name="plus" size={13} color="var(--text-faint)" />
          </button>
        </div>
      )}
      {namingAlbum && !collapsed ? (
        <input
          className="ovl-sidebar__albumname"
          aria-label={intl.formatMessage(messages.albumName)}
          placeholder={intl.formatMessage(messages.albumName)}
          // The affordance just appeared under the pointer — take focus so
          // Enter/Escape work immediately.
          autoFocus
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setNamingAlbum(false);
            } else if (event.key === 'Enter') {
              const name = event.currentTarget.value.trim();
              if (name !== '') {
                // The albums list refreshes off the library:changed push.
                void window.overlook.albums.create({ name }).catch(() => undefined);
                setNamingAlbum(false);
              }
            }
          }}
          onBlur={() => {
            setNamingAlbum(false);
          }}
        />
      ) : null}
      <span id={albumReorder.instructionId} className="ovl-sr-only">
        <FormattedMessage
          id="album.reorder.instructions"
          defaultMessage="Press Space or Enter to grab. Use arrow keys to move, Space or Enter to drop, and Escape to cancel."
        />
      </span>
      <ul
        className="ovl-sidebar__albumlist"
        aria-label={intl.formatMessage(messages.headingAlbums)}
        aria-roledescription={albumReorder.grabbedId === null ? undefined : 'reorderable list'}
      >
        {albumReorder.albums.map((album, albumIndex) => {
          const photoDropProps = albumDrop.targetProps(album);
          const reorderRowProps = albumReorder.rowProps(album);
          return (
            // A list item is intentionally the drop boundary; activation remains on its nested button.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- typed album/photo drop target
            <li
              className={`ovl-sidebar__albumrow${albumDrop.feedback?.albumId === album.id ? ` ovl-sidebar__albumrow--drop-${albumDrop.feedback.phase}` : ''}${albumReorder.grabbedId === album.id ? ' ovl-sidebar__albumrow--grabbed' : ''}${albumReorder.draggingId === album.id ? ' ovl-sidebar__albumrow--dragging' : ''}`}
              key={album.id}
              onDragEnter={(event) => {
                reorderRowProps.onDragEnter(event);
                if (!event.isPropagationStopped()) photoDropProps.onDragEnter(event);
              }}
              onDragOver={(event) => {
                reorderRowProps.onDragOver(event);
                if (!event.isPropagationStopped()) photoDropProps.onDragOver(event);
              }}
              onDragLeave={photoDropProps.onDragLeave}
              onDrop={(event) => {
                reorderRowProps.onDrop(event);
                if (!event.isPropagationStopped()) photoDropProps.onDrop(event);
              }}
            >
              <SideRow
                icon="album"
                label={album.name}
                count={album.count}
                active={state.album === album.id}
                collapsed={collapsed}
                positionLabel={
                  collapsed
                    ? intl.formatMessage(
                        { id: 'album.reorder.positionSuffix', defaultMessage: 'album {position} of {total}' },
                        { position: albumIndex + 1, total: albumReorder.albums.length },
                      )
                    : undefined
                }
                statusLabel={albumDrop.feedback?.albumId === album.id ? albumDrop.feedback.label : undefined}
                onClick={() => {
                  dispatch({ type: 'album/set', albumId: album.id });
                }}
                onOpenActions={(position, origin) => {
                  albumActionOriginRef.current = origin;
                  setAlbumMenu({ album, ...position });
                }}
                onReorderShortcut={(command) => albumReorder.moveByCommand(album, command)}
              />
              {collapsed ? null : (
                <Tooltip label={intl.formatMessage({ id: 'album.reorder.tooltip', defaultMessage: 'Reorder album' })} side="right">
                  <button type="button" className="ovl-sidebar__album-reorder" {...albumReorder.handleProps(album)}>
                    <Icon name="grip-vertical" size={15} />
                  </button>
                </Tooltip>
              )}
              {collapsed ? null : (
                <button
                  type="button"
                  className="ovl-sidebar__album-actions"
                  aria-label={intl.formatMessage(
                    { id: 'sidebar.album.actions', defaultMessage: 'Actions for {name}' },
                    { name: album.name },
                  )}
                  aria-haspopup="menu"
                  tabIndex={-1}
                  onClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    albumActionOriginRef.current = event.currentTarget;
                    setAlbumMenu({ album, x: direction === 'rtl' ? bounds.left : bounds.right - 190, y: bounds.bottom + 4 });
                  }}
                >
                  <Icon name="sliders-horizontal" size={12} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {protectedAlbums.length === 0 ? null : collapsed ? (
        <div className="ovl-sidebar__divider" role="presentation" />
      ) : (
        <div className="ovl-sidebar__heading mono-data">
          <h2 className="ovl-sidebar__headingText">
            <FormattedMessage id="sidebar.heading.protected" defaultMessage="Protected" />
          </h2>
        </div>
      )}
      {protectedAlbums.map((album) => {
        const label = album.locked ? album.label : (album.name ?? album.label);
        return (
          <SideRow
            key={album.id}
            icon="lock"
            label={label}
            count={album.locked ? null : (album.count ?? null)}
            active={state.protectedAlbum === album.id}
            collapsed={collapsed}
            onClick={onProtectedOpen === undefined ? undefined : (origin) => onProtectedOpen(album.id, origin)}
          />
        );
      })}
      {albumDrop.choice === null ? null : (
        <AlbumDropDialog
          count={albumDrop.choice.payload.photoIds.length}
          source={albumDrop.choice.source}
          target={albumDrop.choice.target}
          onAdd={albumDrop.chooseAdd}
          onMove={albumDrop.chooseMove}
          onClose={albumDrop.closeChoice}
        />
      )}
      {albumMenu === null ? null : (
        <AlbumActionMenu
          album={albumMenu.album}
          x={albumMenu.x}
          y={albumMenu.y}
          onClose={() => {
            setAlbumMenu(null);
            restoreAlbumActionFocus();
          }}
          onRename={() => {
            setAlbumMenu(null);
            setRenamingAlbum(albumMenu.album);
          }}
          onDelete={() => {
            setAlbumMenu(null);
            setDeletingAlbum(albumMenu.album);
          }}
          onTransfer={
            onTransferAlbum === undefined
              ? undefined
              : () => {
                  setAlbumMenu(null);
                  onTransferAlbum(albumMenu.album);
                }
          }
          position={albumReorder.albums.findIndex(({ id }) => id === albumMenu.album.id)}
          total={albumReorder.albums.length}
          platform={platform}
          onReorder={(command) => {
            const album = albumMenu.album;
            setAlbumMenu(null);
            albumReorder.moveByCommand(album, command);
            restoreAlbumActionFocus();
          }}
        />
      )}
      {renamingAlbum === null ? null : (
        <RenameAlbumDialog
          key={renamingAlbum.id}
          album={renamingAlbum}
          onClose={() => {
            setRenamingAlbum(null);
            restoreAlbumActionFocus();
          }}
          onComplete={(name) => {
            setRenamingAlbum(null);
            dispatch({ type: 'toast/shown', toast: { title: `Renamed album to ${name}`, tone: 'green' } });
            restoreAlbumActionFocus();
          }}
        />
      )}
      {deletingAlbum === null ? null : (
        <DeleteAlbumDialog
          key={deletingAlbum.id}
          album={deletingAlbum}
          onClose={() => {
            setDeletingAlbum(null);
            restoreAlbumActionFocus();
          }}
          onComplete={() => {
            if (state.album === deletingAlbum.id) dispatch({ type: 'source/set', source: 'all' });
            dispatch({
              type: 'toast/shown',
              toast: {
                title: `Deleted ${deletingAlbum.name} · ${formatCount(deletingAlbum.count)} ${deletingAlbum.count === 1 ? 'photo' : 'photos'} kept`,
                tone: 'neutral',
              },
            });
            setDeletingAlbum(null);
            // The opener belongs to the row being removed. Move focus to a
            // stable destination instead of leaving keyboard focus on body.
            albumActionOriginRef.current = null;
            requestAnimationFrame(() => allPhotosRef.current?.focus());
          }}
        />
      )}
      <div className="ovl-sidebar__spacer" />
      {collapsed ? (
        <Tooltip
          label={
            backupRun !== null && backupRun.done < backupRun.total
              ? intl.formatMessage({ id: 'sidebar.encrypted.backingUp', defaultMessage: 'Library encrypted · backing up' })
              : intl.formatMessage(messages.encrypted)
          }
          side={inlineEndSide}
        >
          <button
            type="button"
            className="ovl-sidebar__shield"
            data-testid="backup-shield"
            aria-label={intl.formatMessage(messages.encryptedOpenSettings)}
            onClick={() => {
              dispatch({ type: 'dialog/set', dialog: 'settings', open: true });
            }}
          >
            <Icon name="shield-check" size={15} color="var(--accent-green)" />
          </button>
        </Tooltip>
      ) : (
        <div className="ovl-sidebar__card" data-testid="backup-card">
          <div className="ovl-sidebar__card-head">
            <Icon name="shield-check" size={14} color="var(--accent-green)" />
            <span className="ovl-sidebar__card-title">
              <FormattedMessage id="sidebar.encrypted" defaultMessage="Library encrypted" />
            </span>
            <button
              type="button"
              className="ovl-sidebar__gear"
              aria-label={intl.formatMessage(messages.settings)}
              onClick={() => {
                dispatch({ type: 'dialog/set', dialog: 'settings', open: true });
              }}
            >
              <Icon name="settings-2" size={13} color="var(--text-faint)" />
            </button>
          </div>
          {state.providerConnected && backupRun !== null && backupRun.done < backupRun.total ? (
            <ProgressBar
              label={intl.formatMessage({ id: 'sidebar.backingUp', defaultMessage: 'Backing up' })}
              detail={`${formatCount(backupRun.done)} / ${formatCount(backupRun.total)}`}
              value={backupRun.done}
              max={Math.max(backupRun.total, 1)}
              tone="amber"
            />
          ) : null}
          <div className="ovl-sidebar__storage mono-data">
            {stats === null ? (
              '—'
            ) : (
              <>
                <div>
                  {intl.formatMessage(messages.storageOnDisk, {
                    bytes: formatBytes(stats.bytes - stats.offloadedBytes),
                  })}
                </div>
                {state.providerConnected ? (
                  <div>
                    {intl.formatMessage(messages.storageOffload, {
                      bytes: formatBytes(stats.offloadedBytes),
                      provider: state.providerLabel,
                    })}
                  </div>
                ) : null}
              </>
            )}
          </div>
          {state.providerConnected ? null : (
            // Disconnected (#239): say so and offer the path back — never a
            // fabricated backup figure.
            <button
              type="button"
              className="ovl-sidebar__connect"
              data-testid="sidebar-connect"
              onClick={() => {
                dispatch({ type: 'dialog/set', dialog: 'settings', open: true });
              }}
            >
              <Icon name="cloud-off" size={12} color="var(--text-faint)" />
              <span>
                <FormattedMessage
                  id="sidebar.notConnected"
                  defaultMessage="{provider} not connected — <cta>Connect</cta>"
                  values={{
                    provider: state.providerLabel,
                    cta: (chunks) => <span className="ovl-sidebar__connect-cta">{chunks}</span>,
                  }}
                />
              </span>
            </button>
          )}
        </div>
      )}
    </nav>
  );
}
