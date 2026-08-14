import { useEffect, useRef, type ReactElement } from 'react';

import { useFormats } from '../i18n/use-formats.js';
import type { LibraryStats } from '../../../shared/library/types.js';
import type { RestoreProgressContract } from '../../../shared/backup/restore-contract.js';
import { Icon } from '../components/Icon';
import { useAppState } from '../state/app-state-context';
import { useAnnouncer } from '../components/LiveAnnouncer';

// The 26px mono strip (#81) per the design's StatusBar.jsx — always tells
// the truth about the library. The sync side flips on pendingCount events;
// the real backup engine (and real lastBackup stamps) land with M08.
export function StatusBar({
  stats,
  restore = null,
  onRestoreClick,
}: {
  readonly stats: LibraryStats | null;
  readonly restore?: RestoreProgressContract | null;
  readonly onRestoreClick?: (() => void) | undefined;
}): ReactElement {
  const { formatBytes, formatCount } = useFormats();
  const state = useAppState();
  const { announce } = useAnnouncer();
  const syncing = state.pendingCount > 0;
  const provider = state.providerLabel;
  const restoreLabel =
    restore === null
      ? null
      : `${restore.stage === 'verifying' ? 'Verifying' : 'Restoring'} ${String(restore.done)} / ${String(Math.max(restore.total, 1))}`;
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
