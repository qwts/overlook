import { useEffect, useRef, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { useFormats } from '../i18n/use-formats.js';
import type { LibraryStats, SourceCounts } from '../../../shared/library/types.js';
import type { RestoreProgressContract } from '../../../shared/backup/restore-contract.js';
import { restoreChipLabel } from '../restore/restore-progress.js';
import { Icon } from '../components/Icon';
import { useAppState } from '../state/app-state-context';
import { useAnnouncer } from '../components/LiveAnnouncer';

const messages = defineMessages({
  excluded: {
    id: 'statusbar.inclusion.excluded',
    defaultMessage: '{count, plural, one {# photo hidden} other {# photos hidden}} by All Photos rules',
  },
  hiddenByAlbums: {
    id: 'statusbar.inclusion.hiddenByAlbums',
    defaultMessage: '{count, plural, one {# photo hidden} other {# photos hidden}} by album settings',
  },
});

// The 26px mono strip (#81) per the design's StatusBar.jsx — always tells
// the truth about the library. The sync side flips on pendingCount events;
// the real backup engine (and real lastBackup stamps) land with M08.
export function StatusBar({
  stats,
  counts = null,
  restore = null,
  onRestoreClick,
  onInclusionClick,
}: {
  readonly stats: LibraryStats | null;
  /** Sidebar counts; `excluded` drives the All Photos inclusion disclosure (#512). */
  readonly counts?: SourceCounts | null;
  readonly restore?: RestoreProgressContract | null;
  readonly onRestoreClick?: (() => void) | undefined;
  readonly onInclusionClick?: (() => void) | undefined;
}): ReactElement {
  const { formatBytes, formatCount } = useFormats();
  const intl = useIntl();
  const state = useAppState();
  // ADR-0030 §4: an All Photos that is filtered must say so and show the
  // excluded count. Albums, other sources, and explicit search are never
  // filtered, so the disclosure only appears on the plain All Photos view.
  const plainAllPhotos = state.source === 'all' && state.album === null && state.protectedAlbum === null && state.query === '';
  const excluded = counts !== null && plainAllPhotos ? counts.excluded : 0;
  // ADR-0030 §2: albums hidden from All Photos are disclosed the same way,
  // as their own number — they are a per-album setting, not a Settings rule.
  const hiddenByAlbums = counts !== null && plainAllPhotos ? counts.hiddenByAlbums : 0;
  const { announce } = useAnnouncer();
  const syncing = state.pendingCount > 0;
  const provider = state.providerLabel;
  const restoreLabel = restore === null ? null : restoreChipLabel(restore);
  const announcement =
    restoreLabel !== null
      ? restoreLabel
      : !state.providerConnected
        ? `${provider} not connected`
        : syncing
          ? `Encrypting ${formatCount(state.pendingCount)} to ${provider}`
          : `All backed up. ${state.lastBackupLabel}`;
  const previousAnnouncement = useRef(announcement);
  useEffect(() => {
    if (previousAnnouncement.current === announcement) return;
    previousAnnouncement.current = announcement;
    announce(announcement, 'polite', 'backup-status');
  }, [announce, announcement]);
  return (
    <footer className="ovl-statusbar">
      <span data-testid="statusbar-left">{stats === null ? '—' : `${formatCount(stats.photos)} photos · ${formatBytes(stats.bytes)}`}</span>
      {excluded > 0 ? (
        <button
          type="button"
          className="ovl-statusbar__item ovl-statusbar__item--amber"
          data-testid="inclusion-status"
          onClick={onInclusionClick}
        >
          <Icon name="eye-off" size={11} strokeWidth={2} />
          {intl.formatMessage(messages.excluded, { count: excluded })}
        </button>
      ) : null}
      {hiddenByAlbums > 0 ? (
        <span className="ovl-statusbar__item ovl-statusbar__item--amber" data-testid="album-visibility-status">
          <Icon name="eye-off" size={11} strokeWidth={2} />
          {intl.formatMessage(messages.hiddenByAlbums, { count: hiddenByAlbums })}
        </span>
      ) : null}
      <span className="ovl-statusbar__spacer" />
      {restore !== null && restoreLabel !== null ? (
        <button
          type="button"
          className="ovl-statusbar__item ovl-statusbar__item--amber ovl-statusbar__restore"
          data-testid="restore-status"
          onClick={onRestoreClick}
        >
          <span className="ovl-statusbar__spin">
            <Icon name="refresh-cw" size={11} strokeWidth={2} />
          </span>
          {restoreLabel}
        </button>
      ) : !state.providerConnected ? (
        // Disconnected (#239): a faint statement of fact, never a fabricated
        // backed-up state.
        <span className="ovl-statusbar__item" data-testid="sync-state">
          <Icon name="cloud-off" size={12} strokeWidth={2} />
          {provider} not connected
        </span>
      ) : syncing ? (
        <span className="ovl-statusbar__item ovl-statusbar__item--amber" data-testid="sync-state">
          <span className="ovl-statusbar__spin">
            <Icon name="refresh-cw" size={11} strokeWidth={2} />
          </span>
          Encrypting {formatCount(state.pendingCount)} → {provider}
        </span>
      ) : (
        <span className="ovl-statusbar__item ovl-statusbar__item--green" data-testid="sync-state">
          <Icon name="cloud-check" size={12} strokeWidth={2} />
          All backed up · {state.lastBackupLabel}
        </span>
      )}
      <span className="ovl-statusbar__item ovl-statusbar__item--green">
        <Icon name="lock" size={11} strokeWidth={2} />
        AES-256
      </span>
    </footer>
  );
}
