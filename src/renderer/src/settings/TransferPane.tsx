import { useEffect, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { LocalTransferStatus } from '../../../shared/ipc/local-transfer-channels.js';
import { Button } from '../components/Button.js';

export interface TransferPaneProps {
  readonly onOpen: (() => void) | undefined;
}

const messages = defineMessages({
  label: { id: 'settings.transfer.label', defaultMessage: 'Transfer and Sync settings' },
  heading: { id: 'settings.transfer.heading', defaultMessage: 'Transfer & Sync' },
  body: {
    id: 'settings.transfer.body',
    defaultMessage: 'Receive photos from Image Trail on this Mac. Enable, then paste the sync code into Image Trail once.',
  },
  enable: { id: 'settings.transfer.enable', defaultMessage: 'Enable' },
  disable: { id: 'settings.transfer.disable', defaultMessage: 'Disable' },
  enabled: { id: 'settings.transfer.enabled', defaultMessage: 'Listening for transfers' },
  disabled: { id: 'settings.transfer.disabledState', defaultMessage: 'Off' },
  syncCode: { id: 'settings.transfer.syncCode', defaultMessage: 'Sync code' },
  copy: { id: 'settings.transfer.copy', defaultMessage: 'Copy' },
  copied: { id: 'settings.transfer.copied', defaultMessage: 'Copied' },
  syncCodeHint: {
    id: 'settings.transfer.syncCodeHint',
    defaultMessage: 'A new code is generated each time transfers are enabled.',
  },
});

export function TransferPane(_props: TransferPaneProps): ReactElement {
  const intl = useIntl();
  const [status, setStatus] = useState<LocalTransferStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    void window.overlook.localTransfer.status().then((initial) => {
      if (active) setStatus(initial);
    });
    return () => {
      active = false;
    };
  }, []);

  const run = (operation: () => Promise<LocalTransferStatus>): void => {
    setBusy(true);
    setCopied(false);
    void operation()
      .then((next) => setStatus(next))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  const enabled = status?.enabled === true;
  const syncString = status?.syncString ?? null;

  return (
    <section className="ovl-settings__transfer" aria-label={intl.formatMessage(messages.label)}>
      <h3>{intl.formatMessage(messages.heading)}</h3>
      <p>{intl.formatMessage(messages.body)}</p>
      <div className="ovl-settings__transferCard" data-testid="local-transfer-card">
        <div>
          <strong>{intl.formatMessage(messages.heading)}</strong>
          <p className="mono-data">{intl.formatMessage(enabled ? messages.enabled : messages.disabled)}</p>
        </div>
        <Button
          variant={enabled ? 'secondary' : 'primary'}
          disabled={busy || status === null}
          onClick={() => run(() => (enabled ? window.overlook.localTransfer.disable() : window.overlook.localTransfer.enable()))}
        >
          {intl.formatMessage(enabled ? messages.disable : messages.enable)}
        </Button>
      </div>
      {enabled && syncString !== null ? (
        <div className="ovl-settings__transferCard" data-testid="local-transfer-sync-code">
          <div>
            <strong>{intl.formatMessage(messages.syncCode)}</strong>
            <p className="mono-data">{syncString}</p>
            <p>{intl.formatMessage(messages.syncCodeHint)}</p>
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(syncString).then(() => setCopied(true));
            }}
          >
            {intl.formatMessage(copied ? messages.copied : messages.copy)}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
