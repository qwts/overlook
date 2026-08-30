import { useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { CustodyRequirement, ProviderConnectResult } from '../../../shared/backup/provider-descriptor.js';
import { destructiveActions } from '../../../shared/destructive-actions.js';
import { Button } from '../components/Button.js';
import { CopyableValue } from '../components/CopyableValue.js';
import { Dialog } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { useFormats } from '../i18n/use-formats.js';

const messages = defineMessages({
  title: { id: 'settings.storage.disconnect.title', defaultMessage: 'Disconnect {name}?' },
  cancel: { id: 'settings.storage.disconnect.cancel', defaultMessage: 'Cancel' },
  checking: { id: 'settings.storage.disconnect.checking', defaultMessage: 'Checking cloud-only originals…' },
  safeCopy: {
    id: 'settings.storage.disconnect.safeCopy',
    defaultMessage: 'This removes this device’s saved {name} authorization.',
  },
  safeReassurance: {
    id: 'settings.storage.disconnect.reassurance',
    defaultMessage: 'Encrypted data already stored in {name} is not deleted.',
  },
  riskCopy: {
    id: 'settings.storage.disconnect.riskCopy',
    defaultMessage:
      '{count, plural, one {# cloud-only original} other {# cloud-only originals}} ({bytes}) will be unavailable until you reconnect {name} as {account}.',
  },
  libraryRisk: {
    id: 'settings.storage.disconnect.libraryRisk',
    defaultMessage: '{name}: {count, plural, one {# original} other {# originals}} · {bytes}',
  },
  legacy: { id: 'settings.storage.disconnect.legacy', defaultMessage: 'not yet verified' },
  libraryWithLegacy: { id: 'settings.storage.disconnect.libraryWithLegacy', defaultMessage: '{library} · {legacy}' },
  unverified: {
    id: 'settings.storage.disconnect.unverified',
    defaultMessage: 'Open {libraries} before disconnecting so Overlook can verify their cloud-only custody.',
  },
  restoreFirst: { id: 'settings.storage.disconnect.restoreFirst', defaultMessage: 'Restore all originals first' },
  restoring: { id: 'settings.storage.disconnect.restoring', defaultMessage: 'Restoring…' },
  removing: { id: 'settings.storage.disconnect.removing', defaultMessage: 'Removing authorization…' },
  disconnecting: { id: 'settings.storage.disconnect.progress', defaultMessage: 'Disconnecting…' },
  emergencyMenuAction: { id: 'settings.storage.disconnect.emergencyMenuAction', defaultMessage: '{action}…' },
  retry: { id: 'settings.storage.disconnect.retry', defaultMessage: 'Try again' },
  unavailable: {
    id: 'settings.storage.disconnect.unavailable',
    defaultMessage: 'Overlook could not verify cloud-only custody. Authorization remains connected.',
  },
  sameAccount: { id: 'settings.storage.disconnect.sameAccount', defaultMessage: 'the same account' },
  emergencyTitle: {
    id: 'settings.storage.disconnect.emergencyTitle',
    defaultMessage: 'Remove {name} authorization anyway?',
  },
  emergencyCopy: {
    id: 'settings.storage.disconnect.emergencyCopy',
    defaultMessage:
      'Overlook will keep every cloud-only original bound to {name}. Reconnect {name} as {account} to open, restore, or export them.',
  },
  providerRequired: { id: 'settings.storage.custody.required', defaultMessage: '{name} required' },
  recoveryRequirement: {
    id: 'settings.storage.custody.recoveryRequirement',
    defaultMessage:
      'Reconnect {name} as {account} to recover access to {count, plural, one {# cloud-only original} other {# cloud-only originals}}.',
  },
  countAndBytes: { id: 'settings.storage.custody.countAndBytes', defaultMessage: '{count} · {bytes}' },
  copyAccountId: { id: 'settings.storage.custody.copyAccountId', defaultMessage: 'provider account ID' },
  copyLibraryId: { id: 'settings.storage.custody.copyLibraryId', defaultMessage: 'library ID {libraryId}' },
  copyError: { id: 'settings.storage.custody.copyError', defaultMessage: 'recovery error' },
});

export interface DisconnectProviderDialogProps {
  readonly open: boolean;
  readonly name: string;
  readonly accountLabel: string | null;
  readonly loading: boolean;
  readonly result: ProviderConnectResult | null;
  readonly operation: 'disconnect' | 'restore' | 'remove-authorization' | null;
  readonly restoreSummary: string | null;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onRetry: () => void;
  readonly onDisconnect: () => void;
  readonly onRestoreAll: () => void;
  readonly onRemoveAuthorization: () => void;
}

export function DisconnectProviderDialog(props: DisconnectProviderDialogProps): ReactElement {
  const intl = useIntl();
  const { formatBytes, formatCount } = useFormats();
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const custody = props.result?.custody;
  const account = props.accountLabel ?? custody?.credential.accountId ?? intl.formatMessage(messages.sameAccount);
  const atRisk = custody !== undefined && (custody.totalItems > 0 || (custody.unverifiedLibraries?.length ?? 0) > 0);
  // Fail closed even if a malformed or stale backend result combines `ok`
  // with nonzero custody. The reassurance must never accompany known risk.
  const ordinaryAllowed = !props.loading && props.result?.ok === true && !atRisk;
  const canRestore = custody !== undefined && custody.totalItems > 0;
  const busy = props.operation !== null;

  return (
    <>
      <Dialog
        open={props.open}
        title={intl.formatMessage(messages.title, { name: props.name })}
        icon="cloud"
        width={420}
        {...(busy ? {} : { onClose: props.onClose })}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={props.onClose}>
              {intl.formatMessage(messages.cancel)}
            </Button>
            {ordinaryAllowed ? (
              <Button disabled={busy} onClick={props.onDisconnect}>
                {props.operation === 'disconnect'
                  ? intl.formatMessage(messages.disconnecting)
                  : destructiveActions.disconnectProvider.label}
              </Button>
            ) : atRisk ? (
              <>
                {canRestore ? (
                  <Button disabled={busy} onClick={props.onRestoreAll}>
                    {props.operation === 'restore' ? intl.formatMessage(messages.restoring) : intl.formatMessage(messages.restoreFirst)}
                  </Button>
                ) : null}
                <Button variant="secondary" disabled={busy} onClick={() => setEmergencyOpen(true)}>
                  {intl.formatMessage(messages.emergencyMenuAction, {
                    action: destructiveActions.removeProviderAuthorizationAnyway.label,
                  })}
                </Button>
              </>
            ) : props.loading ? null : (
              <Button disabled={busy} onClick={props.onRetry}>
                {intl.formatMessage(messages.retry)}
              </Button>
            )}
          </>
        }
      >
        <div className="ovl-settings__disconnectState" aria-live="polite">
          {props.loading ? <p>{intl.formatMessage(messages.checking)}</p> : null}
          {ordinaryAllowed ? (
            <>
              <p>{intl.formatMessage(messages.safeCopy, { name: props.name })}</p>
              <div className="ovl-settings__disconnectReassure">
                <Icon name="shield-check" size={16} color="var(--accent-green)" />
                <span>{intl.formatMessage(messages.safeReassurance, { name: props.name })}</span>
              </div>
            </>
          ) : null}
          {atRisk && custody !== undefined ? (
            <>
              <div className="ovl-settings__disconnectRisk" role="alert">
                <Icon name="triangle-alert" size={16} />
                <span>
                  {intl.formatMessage(messages.riskCopy, {
                    count: custody.totalItems,
                    bytes: formatBytes(custody.totalBytes),
                    name: props.name,
                    account,
                  })}
                </span>
              </div>
              <CopyableValue
                value={custody.credential.accountId}
                label={intl.formatMessage(messages.copyAccountId)}
                className="ovl-settings__disconnectIdentifier"
              />
              <ul className="ovl-settings__disconnectLibraries">
                {custody.libraries.map((library) => (
                  <li key={library.libraryId}>
                    <span className="mono-data">
                      {library.legacyUnbound
                        ? intl.formatMessage(messages.libraryWithLegacy, {
                            library: intl.formatMessage(messages.libraryRisk, {
                              name: library.name,
                              count: library.items,
                              bytes: formatBytes(library.bytes),
                            }),
                            legacy: intl.formatMessage(messages.legacy),
                          })
                        : intl.formatMessage(messages.libraryRisk, {
                            name: library.name,
                            count: library.items,
                            bytes: formatBytes(library.bytes),
                          })}
                    </span>
                    <CopyableValue
                      value={library.libraryId}
                      label={intl.formatMessage(messages.copyLibraryId, { libraryId: library.libraryId })}
                    />
                  </li>
                ))}
              </ul>
              {custody.unverifiedLibraries === undefined || custody.unverifiedLibraries.length === 0 ? null : (
                <>
                  <p>
                    {intl.formatMessage(messages.unverified, {
                      libraries: custody.unverifiedLibraries.map((library) => library.name).join(', '),
                    })}
                  </p>
                  <ul className="ovl-settings__disconnectLibraries">
                    {custody.unverifiedLibraries.map((library) => (
                      <li key={library.libraryId}>
                        <span>{library.name}</span>
                        <CopyableValue
                          value={library.libraryId}
                          label={intl.formatMessage(messages.copyLibraryId, { libraryId: library.libraryId })}
                        />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : null}
          {!props.loading && !ordinaryAllowed && !atRisk ? (
            props.result?.reason === null || props.result?.reason === undefined ? (
              <p className="ovl-settings__disconnectError">{intl.formatMessage(messages.unavailable)}</p>
            ) : (
              <CopyableValue
                value={props.result.reason}
                label={intl.formatMessage(messages.copyError)}
                className="ovl-settings__disconnectError"
              />
            )
          ) : null}
          {props.error === null ? null : (
            <CopyableValue value={props.error} label={intl.formatMessage(messages.copyError)} className="ovl-settings__disconnectError" />
          )}
          {props.restoreSummary === null ? null : <p className="mono-data">{props.restoreSummary}</p>}
        </div>
      </Dialog>

      <Dialog
        open={props.open && emergencyOpen}
        title={intl.formatMessage(messages.emergencyTitle, { name: props.name })}
        icon="triangle-alert"
        width={420}
        {...(props.operation === 'remove-authorization' ? {} : { onClose: () => setEmergencyOpen(false) })}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setEmergencyOpen(false)}>
              {intl.formatMessage(messages.cancel)}
            </Button>
            <Button variant="danger" disabled={busy} onClick={props.onRemoveAuthorization}>
              {props.operation === 'remove-authorization'
                ? intl.formatMessage(messages.removing)
                : destructiveActions.removeProviderAuthorizationAnyway.label}
            </Button>
          </>
        }
      >
        <div className="ovl-settings__disconnectState" role="alert">
          <p>{intl.formatMessage(messages.emergencyCopy, { name: props.name, account })}</p>
          <p>{destructiveActions.removeProviderAuthorizationAnyway.survival}</p>
          {custody === undefined ? null : (
            <p className="mono-data">
              {intl.formatMessage(messages.countAndBytes, {
                count: formatCount(custody.totalItems),
                bytes: formatBytes(custody.totalBytes),
              })}
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}

export function CustodyRequirementBanner({
  name,
  requirement,
}: {
  readonly name: string;
  readonly requirement: CustodyRequirement;
}): ReactElement {
  const intl = useIntl();
  const { formatBytes, formatCount } = useFormats();
  return (
    <section className="ovl-settings__custodyRequirement" role="status" aria-live="polite">
      <Icon name="triangle-alert" size={16} />
      <div>
        <strong>{intl.formatMessage(messages.providerRequired, { name })}</strong>
        <span>
          {intl.formatMessage(messages.recoveryRequirement, {
            name,
            account: requirement.accountLabel,
            count: requirement.items,
          })}
        </span>
        <CopyableValue value={requirement.accountId} label={intl.formatMessage(messages.copyAccountId)} />
        <span className="mono-data">
          {intl.formatMessage(messages.countAndBytes, {
            count: formatCount(requirement.items),
            bytes: formatBytes(requirement.bytes),
          })}
        </span>
      </div>
    </section>
  );
}
