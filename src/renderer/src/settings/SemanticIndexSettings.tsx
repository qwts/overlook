import { useEffect, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { Button } from '../components/Button';
import { Switch } from '../components/Switch';

type Status = Awaited<ReturnType<typeof window.overlook.embedding.status>>;

const messages = defineMessages({
  toggle: { id: 'settings.general.semantic.toggle', defaultMessage: 'Enable semantic indexing' },
  download: {
    id: 'settings.general.semantic.download',
    defaultMessage: 'Downloads a 148 MB on-device model once. Photos and embeddings never leave this device.',
  },
  off: { id: 'settings.general.semantic.off', defaultMessage: 'Off' },
  downloading: { id: 'settings.general.semantic.downloading', defaultMessage: 'Downloading model… {percent}%' },
  indexing: { id: 'settings.general.semantic.indexing', defaultMessage: 'Indexing {completed} of {total} photos' },
  ready: { id: 'settings.general.semantic.ready', defaultMessage: 'Index up to date' },
  paused: { id: 'settings.general.semantic.paused', defaultMessage: 'Indexing paused: {reason}' },
  failed: { id: 'settings.general.semantic.failed', defaultMessage: 'Indexing needs attention' },
  pause: { id: 'settings.general.semantic.pause', defaultMessage: 'Pause' },
  resume: { id: 'settings.general.semantic.resume', defaultMessage: 'Resume' },
  reasonUser: { id: 'settings.general.semantic.reason.user', defaultMessage: 'you paused it' },
  reasonImport: { id: 'settings.general.semantic.reason.import', defaultMessage: 'import in progress' },
  reasonBackup: { id: 'settings.general.semantic.reason.backup', defaultMessage: 'backup in progress' },
  reasonBattery: { id: 'settings.general.semantic.reason.battery', defaultMessage: 'running on battery' },
});

export function SemanticIndexSettings(): ReactElement {
  const intl = useIntl();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.overlook.embedding.onChanged((next) => {
      if (active) setStatus(next);
    });
    void window.overlook.embedding.status().then((next) => {
      if (active) setStatus(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const enabled = status !== null && status.phase !== 'disabled';
  const pauseReason = status?.pauseReason;
  const reason =
    pauseReason === 'user'
      ? messages.reasonUser
      : pauseReason === 'import'
        ? messages.reasonImport
        : pauseReason === 'backup'
          ? messages.reasonBackup
          : messages.reasonBattery;
  const progress =
    status === null || status.phase === 'disabled'
      ? intl.formatMessage(messages.off)
      : status.phase === 'downloading'
        ? intl.formatMessage(messages.downloading, {
            percent: status.downloadBytes === 0 ? 0 : Math.min(100, Math.floor((status.downloadedBytes / status.downloadBytes) * 100)),
          })
        : status.phase === 'indexing'
          ? intl.formatMessage(messages.indexing, { completed: status.completed, total: status.total })
          : status.phase === 'ready'
            ? intl.formatMessage(messages.ready)
            : status.phase === 'paused'
              ? intl.formatMessage(messages.paused, { reason: intl.formatMessage(reason) })
              : intl.formatMessage(messages.failed);

  const changeEnabled = (next: boolean): void => {
    setBusy(true);
    const request = next ? window.overlook.embedding.enable() : window.overlook.embedding.disable();
    void request.then(setStatus).finally(() => setBusy(false));
  };

  return (
    <div className="ovl-settings__semantic" data-testid="semantic-index-settings">
      <Switch checked={enabled} disabled={busy} label={intl.formatMessage(messages.toggle)} onChange={changeEnabled} />
      <span className="ovl-settings__semanticStatus" role="status">
        {progress}
      </span>
      {status?.phase === 'indexing' ? (
        <Button
          variant="ghost"
          onClick={() => {
            void window.overlook.embedding.pause().then(setStatus);
          }}
        >
          {intl.formatMessage(messages.pause)}
        </Button>
      ) : status?.phase === 'paused' && status.pauseReason === 'user' ? (
        <Button
          variant="ghost"
          onClick={() => {
            void window.overlook.embedding.resume().then(setStatus);
          }}
        >
          {intl.formatMessage(messages.resume)}
        </Button>
      ) : null}
    </div>
  );
}

export const semanticIndexHint = messages.download;
