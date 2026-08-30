import type { ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import './settings.css';
import { useFormats } from '../i18n/use-formats.js';
import { Badge } from '../components/Badge';
import { Button, type ButtonVariant } from '../components/Button';
import { CopyableValue } from '../components/CopyableValue';
import { Icon } from '../components/Icon';
import { ProgressBar } from '../components/ProgressBar';

// Provider storage card (#684). Presentation only — a pure view of connection
// authority and provider-native account capacity. Google Drive and pCloud show
// capacity only from their quota APIs; iCloud links to System Settings because
// it exposes no trustworthy account-quota API.

export type ProviderConnectionState = 'connected' | 'disconnected' | 'checking' | 'error';

export type ProviderCapacityView =
  | { readonly kind: 'known'; readonly usedBytes: number; readonly totalBytes: number }
  | { readonly kind: 'route' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'none' };

export interface ProviderCardProps {
  readonly name: string;
  readonly connection: ProviderConnectionState;
  readonly account: string | null;
  readonly capacity: ProviderCapacityView;
  readonly capabilitiesLine: string | null;
  /** Backend reason for the disconnected/error state (a failed connect's reason),
   * or null to fall back to the card's own default copy. */
  readonly message: string | null;
  readonly primaryLabel: string;
  readonly primaryVariant: ButtonVariant;
  readonly primaryDisabled: boolean;
  readonly onPrimary: () => void;
  readonly onCapacityRoute: () => void;
}

const messages = defineMessages({
  checking: { id: 'settings.provider.badge.checking', defaultMessage: 'Checking…' },
  connected: { id: 'settings.provider.badge.connected', defaultMessage: 'Connected' },
  statusUnavailable: { id: 'settings.provider.badge.unavailable', defaultMessage: 'Status unavailable' },
  notConnected: { id: 'settings.provider.badge.notConnected', defaultMessage: 'Not connected' },
  checkingConnection: { id: 'settings.provider.checkingConnection', defaultMessage: 'Checking connection…' },
  couldNotCheck: { id: 'settings.provider.couldNotCheck', defaultMessage: 'Could not check this provider’s connection.' },
  capacityBar: { id: 'settings.provider.capacityBar', defaultMessage: '{name} capacity' },
  capacityDetail: { id: 'settings.provider.capacityDetail', defaultMessage: '{used} of {total} used' },
  capacityRoute: { id: 'settings.provider.capacityRoute', defaultMessage: '{name} capacity — View in System Settings' },
  opensSettings: { id: 'settings.provider.opensSettings', defaultMessage: ' (opens System Settings)' },
  capacityUnavailable: { id: 'settings.provider.capacityUnavailable', defaultMessage: 'Account capacity unavailable.' },
  regionLabel: { id: 'settings.provider.regionLabel', defaultMessage: '{name} backup' },
  connectHint: { id: 'settings.provider.connectHint', defaultMessage: 'Link a provider to store encrypted originals off-device.' },
  copyAccount: { id: 'settings.provider.copyAccount', defaultMessage: 'provider account' },
  copyError: { id: 'settings.provider.copyError', defaultMessage: 'provider error' },
});

export function ProviderCard(props: ProviderCardProps): ReactElement {
  const intl = useIntl();
  const { formatBytes } = useFormats();
  const { name, connection, account, capacity } = props;
  const connected = connection === 'connected';

  return (
    <div
      className="ovl-settings__provider"
      role="group"
      aria-label={intl.formatMessage(messages.regionLabel, { name })}
      data-testid="provider-card"
    >
      <Icon name="cloud" size={20} color={connected ? 'var(--accent-cyan)' : 'var(--text-faint)'} />
      <div className="ovl-settings__providerBody">
        <div className="ovl-settings__providerHead">
          <span className="ovl-settings__providerName">{name}</span>
          {connection === 'checking' ? (
            <Badge tone="neutral">{intl.formatMessage(messages.checking)}</Badge>
          ) : connected ? (
            <Badge tone="green" icon="cloud-check">
              {intl.formatMessage(messages.connected)}
            </Badge>
          ) : connection === 'error' ? (
            <Badge tone="neutral" icon="cloud-alert">
              {intl.formatMessage(messages.statusUnavailable)}
            </Badge>
          ) : (
            <Badge tone="neutral">{intl.formatMessage(messages.notConnected)}</Badge>
          )}
        </div>

        {account === null ? null : (
          <CopyableValue value={account} label={intl.formatMessage(messages.copyAccount)} className="ovl-settings__providerMeta" />
        )}

        {connection === 'checking' ? (
          <div className="ovl-settings__providerMeta">{intl.formatMessage(messages.checkingConnection)}</div>
        ) : connection === 'error' ? (
          // Prefer the backend's actionable reason (OAuth/config/custody failure)
          // when a connect attempt supplied one; else the generic status copy.
          props.message === null ? (
            <div className="ovl-settings__providerMeta">{intl.formatMessage(messages.couldNotCheck)}</div>
          ) : (
            <CopyableValue value={props.message} label={intl.formatMessage(messages.copyError)} className="ovl-settings__providerMeta" />
          )
        ) : connected ? (
          <>
            {capacity.kind === 'known' ? (
              <ProgressBar
                label={intl.formatMessage(messages.capacityBar, { name })}
                detail={intl.formatMessage(messages.capacityDetail, {
                  used: formatBytes(capacity.usedBytes),
                  total: formatBytes(capacity.totalBytes),
                })}
                value={capacity.usedBytes}
                max={Math.max(capacity.totalBytes, 1)}
                tone="cyan"
              />
            ) : capacity.kind === 'route' ? (
              <button type="button" className="ovl-settings__providerRoute" onClick={props.onCapacityRoute}>
                <Icon name="sliders-horizontal" size={14} />
                {intl.formatMessage(messages.capacityRoute, { name })}
                <span className="ovl-sr-only">{intl.formatMessage(messages.opensSettings)}</span>
              </button>
            ) : capacity.kind === 'unavailable' ? (
              <div className="ovl-settings__providerMeta">{intl.formatMessage(messages.capacityUnavailable)}</div>
            ) : null}

            {props.capabilitiesLine === null ? null : <div className="ovl-settings__providerMeta mono-data">{props.capabilitiesLine}</div>}
          </>
        ) : props.message === null ? (
          <div className="ovl-settings__providerMeta">{intl.formatMessage(messages.connectHint)}</div>
        ) : (
          <CopyableValue value={props.message} label={intl.formatMessage(messages.copyError)} className="ovl-settings__providerMeta" />
        )}
      </div>

      <Button variant={props.primaryVariant} disabled={props.primaryDisabled} onClick={props.onPrimary}>
        {props.primaryLabel}
      </Button>
    </div>
  );
}
