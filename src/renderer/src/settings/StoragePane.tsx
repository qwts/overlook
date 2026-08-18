import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { Button } from '../components/Button';
import { Segmented } from '../components/Segmented';
import { Slider } from '../components/Slider';
import { Switch } from '../components/Switch';
import { Field } from './Field';
import { OffloadedStorage } from './OffloadedStorage';
import { ProviderCard, type ProviderCapacityView, type ProviderConnectionState } from './ProviderCard';
import { resolveProviderTargetId } from './provider-presentation.js';
import type { AppSettings } from '../../../shared/settings/settings.js';
import type {
  ProviderCapacityStatus,
  ProviderConnectResult,
  ProviderConnectionStatus,
  ProviderDescriptor,
} from '../../../shared/backup/provider-descriptor.js';
import { destructiveActions, PROVIDER_AUTHORIZATION_REMOVAL } from '../../../shared/destructive-actions.js';
import { FileProviderSettings } from './FileProviderSettings';
import { CustodyRequirementBanner, DisconnectProviderDialog } from './DisconnectProviderDialog.js';
import { useFormats } from '../i18n/use-formats.js';

// Storage & Backup section (#114, updated by #239, #254): the provider
// connection card + backup knobs. Disconnected now HIDES the backup-specific
// controls (auto-backup, Wi-Fi only, bandwidth) instead of disabling them —
// only the connection card, import Copy/Move (which needs no provider), and
// the locked Encrypt switch remain, per the updated design.
// Connect/Disconnect goes through backup:connect / backup:disconnect (#254)
// so main owns the handshake — instant for the mock, the OAuth browser
// round-trip for interactive providers; providerId flips in settings and the
// settings-changed push re-renders this pane. Quota is the provider's own
// answer, not a cached guess.

type ProviderStatusLoad =
  | { readonly targetId: string; readonly state: 'ready'; readonly value: ProviderConnectionStatus }
  | { readonly targetId: string; readonly state: 'error' };

type ProviderStorageLoad =
  | { readonly targetId: string; readonly state: 'loading' }
  | { readonly targetId: string; readonly state: 'ready'; readonly value: ProviderCapacityStatus }
  | { readonly targetId: string; readonly state: 'error' };

type ConnectionOperation = 'connect' | 'disconnect' | 'restore' | 'remove-authorization';

type DisconnectPreflightLoad =
  | { readonly targetId: string; readonly state: 'loading' }
  | { readonly targetId: string; readonly state: 'ready'; readonly value: ProviderConnectResult };

const messages = defineMessages({
  disconnectFailed: {
    id: 'settings.storage.disconnect.failed',
    defaultMessage: 'Disconnect failed. Check status and try again.',
  },
  connectFailed: { id: 'settings.storage.connect.failed', defaultMessage: 'Connection failed. Try again.' },
  disconnecting: { id: 'settings.storage.disconnect.progress', defaultMessage: 'Disconnecting…' },
  restoreFailed: {
    id: 'settings.storage.disconnect.restoreFailed',
    defaultMessage: 'Restore failed — authorization remains connected.',
  },
  restoreSummary: {
    id: 'settings.storage.disconnect.restoreSummary',
    defaultMessage: '{restored} restored · {skipped} skipped · {failed} failed',
  },
});

export interface StoragePaneProps {
  readonly settings: AppSettings;
  readonly selectedPhotoIds: readonly string[];
  readonly onRestore?: (() => void) | undefined;
  readonly onProviderSelection?: ((provider: ProviderDescriptor) => void) | undefined;
  readonly preferredProviderId?: string | null | undefined;
  readonly onPatch: (
    patch: Partial<
      Pick<AppSettings, 'autoBackupOnImport' | 'reOffloadAfterViewing' | 'importMode' | 'wifiOnly' | 'bandwidthLimit' | 'providerId'>
    >,
  ) => void;
}

export function StoragePane({
  settings,
  selectedPhotoIds,
  onPatch,
  onRestore,
  onProviderSelection,
  preferredProviderId = null,
}: StoragePaneProps): ReactElement {
  const intl = useIntl();
  const { formatCount } = useFormats();
  const [statusLoad, setStatusLoad] = useState<ProviderStatusLoad | null>(null);
  const [storageLoad, setStorageLoad] = useState<ProviderStorageLoad | null>(null);
  const [providers, setProviders] = useState<readonly ProviderDescriptor[]>([]);
  const [targetId, setTargetId] = useState<string | null>(preferredProviderId ?? settings.providerId);
  const [connectionOperation, setConnectionOperation] = useState<ConnectionOperation | null>(null);
  const [disconnectConfirmation, setDisconnectConfirmation] = useState(false);
  const [disconnectPreflight, setDisconnectPreflight] = useState<DisconnectPreflightLoad | null>(null);
  const [disconnectRestoreSummary, setDisconnectRestoreSummary] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const statusRequestRef = useRef(0);
  const storageRequestRef = useRef(0);
  const providerCatalogRequestRef = useRef(0);
  const disconnectRequestRef = useRef(0);
  const operationRef = useRef<ConnectionOperation | null>(null);

  const loadCapacity = useCallback((providerId: string) => {
    const request = storageRequestRef.current + 1;
    storageRequestRef.current = request;
    setStorageLoad({ targetId: providerId, state: 'loading' });
    void window.overlook.backup
      .providerStorage({ providerId })
      .then((loaded) => {
        if (storageRequestRef.current !== request) return;
        setStorageLoad({ targetId: providerId, state: 'ready', value: loaded });
      })
      .catch(() => {
        if (storageRequestRef.current === request) setStorageLoad({ targetId: providerId, state: 'error' });
      });
  }, []);

  const refresh = useCallback(() => {
    const request = statusRequestRef.current + 1;
    statusRequestRef.current = request;
    if (targetId === null) {
      return;
    }
    void window.overlook.backup
      .providerStatus({ providerId: targetId })
      .then((loaded) => {
        if (statusRequestRef.current !== request) return;
        setStatusLoad({ targetId, state: 'ready', value: loaded });
        if (loaded.connected) loadCapacity(targetId);
      })
      .catch(() => {
        if (statusRequestRef.current === request) setStatusLoad({ targetId, state: 'error' });
      });
  }, [loadCapacity, targetId]);

  const changeConnection = useCallback(
    (operation: Extract<ConnectionOperation, 'connect' | 'disconnect'>) => {
      if (operationRef.current !== null || targetId === null) return;
      operationRef.current = operation;
      setConnectionOperation(operation);
      setConnectError(null);
      if (operation === 'connect') setStatusLoad(null);
      statusRequestRef.current += 1;
      storageRequestRef.current += 1;
      const request =
        operation === 'disconnect'
          ? window.overlook.backup.disconnect({ providerId: targetId })
          : window.overlook.backup.connect({ providerId: targetId });
      void request
        .then((result) => {
          if (!result.ok) {
            setConnectError(result.reason ?? 'Connection failed.');
            setStatusLoad({ targetId, state: 'error' });
            return;
          }
          if (operation === 'disconnect') {
            setDisconnectConfirmation(false);
            const provider = providers.find((candidate) => candidate.id === targetId);
            if (provider !== undefined) onProviderSelection?.(provider);
          }
          refresh();
        })
        .catch(() => {
          setConnectError(intl.formatMessage(operation === 'disconnect' ? messages.disconnectFailed : messages.connectFailed));
          setStatusLoad({ targetId, state: 'error' });
        })
        .finally(() => {
          operationRef.current = null;
          setConnectionOperation(null);
        });
    },
    [intl, onProviderSelection, providers, refresh, targetId],
  );

  const loadDisconnectPreflight = useCallback(
    (providerId: string): Promise<void> => {
      const request = disconnectRequestRef.current + 1;
      disconnectRequestRef.current = request;
      setDisconnectPreflight({ targetId: providerId, state: 'loading' });
      return window.overlook.backup
        .disconnectPreflight({ providerId })
        .then((value) => {
          if (disconnectRequestRef.current === request) setDisconnectPreflight({ targetId: providerId, state: 'ready', value });
        })
        .catch(() => {
          if (disconnectRequestRef.current === request) {
            setDisconnectPreflight({
              targetId: providerId,
              state: 'ready',
              value: { ok: false, reason: intl.formatMessage(messages.disconnectFailed), code: 'custody-unavailable', retryable: true },
            });
          }
        });
    },
    [intl],
  );

  const beginDisconnect = useCallback(() => {
    if (targetId === null || operationRef.current !== null) return;
    setConnectError(null);
    setDisconnectRestoreSummary(null);
    setDisconnectConfirmation(true);
    void loadDisconnectPreflight(targetId);
  }, [loadDisconnectPreflight, targetId]);

  const restoreBeforeDisconnect = useCallback(() => {
    if (targetId === null || operationRef.current !== null) return;
    operationRef.current = 'restore';
    setConnectionOperation('restore');
    setConnectError(null);
    void window.overlook.backup
      .restoreOriginals({})
      .then(({ restored, skipped, failed }) => {
        setDisconnectRestoreSummary(
          intl.formatMessage(messages.restoreSummary, {
            restored: formatCount(restored),
            skipped: formatCount(skipped),
            failed: formatCount(failed),
          }),
        );
        return loadDisconnectPreflight(targetId);
      })
      .catch(() => setConnectError(intl.formatMessage(messages.restoreFailed)))
      .finally(() => {
        operationRef.current = null;
        setConnectionOperation(null);
      });
  }, [formatCount, intl, loadDisconnectPreflight, targetId]);

  const removeAuthorizationAnyway = useCallback(() => {
    if (targetId === null || operationRef.current !== null) return;
    operationRef.current = 'remove-authorization';
    setConnectionOperation('remove-authorization');
    setConnectError(null);
    void window.overlook.backup
      .removeAuthorizationAnyway({ providerId: targetId, authorization: PROVIDER_AUTHORIZATION_REMOVAL })
      .then((result) => {
        if (!result.ok) {
          setConnectError(result.reason ?? intl.formatMessage(messages.disconnectFailed));
          return;
        }
        setDisconnectConfirmation(false);
        const provider = providers.find((candidate) => candidate.id === targetId);
        if (provider !== undefined) onProviderSelection?.(provider);
        refresh();
      })
      .catch(() => setConnectError(intl.formatMessage(messages.disconnectFailed)))
      .finally(() => {
        operationRef.current = null;
        setConnectionOperation(null);
      });
  }, [intl, onProviderSelection, providers, refresh, targetId]);

  // providerId is part of `settings`, so a connect/disconnect patch
  // re-renders this pane and the effect refetches the card's truth.
  useEffect(() => {
    const request = providerCatalogRequestRef.current + 1;
    providerCatalogRequestRef.current = request;
    void window.overlook.backup.providers().then(({ providers: loaded, defaultProviderId }) => {
      if (providerCatalogRequestRef.current !== request) return;
      setProviders(loaded);
      setTargetId((current) => resolveProviderTargetId(loaded, settings.providerId, current, preferredProviderId, defaultProviderId));
    });
    return () => {
      providerCatalogRequestRef.current += 1;
    };
  }, [preferredProviderId, settings.providerId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openCapacitySettings = useCallback(() => {
    if (targetId === null) return;
    void window.overlook.backup.openCapacitySettings({ providerId: targetId });
  }, [targetId]);

  const status = statusLoad?.targetId === targetId && statusLoad.state === 'ready' ? statusLoad.value : null;
  const storage = storageLoad?.targetId === targetId && storageLoad.state === 'ready' ? storageLoad.value : null;
  const descriptor = providers.find((provider) => provider.id === targetId) ?? status?.provider ?? null;
  const errored = statusLoad?.targetId === targetId && statusLoad.state === 'error';
  const connected = status !== null && settings.providerId === targetId && status.connected;

  useEffect(() => {
    if (!connected || targetId === null) return;
    return window.overlook.backup.onCompleted(() => {
      loadCapacity(targetId);
    });
  }, [connected, loadCapacity, targetId]);

  const connection: ProviderConnectionState = errored ? 'error' : status === null ? 'checking' : connected ? 'connected' : 'disconnected';
  const name = descriptor?.label ?? 'Cloud provider';
  const bandwidth = settings.bandwidthLimit;
  const disconnecting = connectionOperation === 'disconnect';
  const connecting = connectionOperation === 'connect';
  // Account capacity: a verified quota (bar), else iCloud's System Settings route,
  // else a plain "unavailable" for a known-quota provider whose call failed.
  const capacity: ProviderCapacityView =
    connected && storage !== null && storage.capacity !== null
      ? { kind: 'known', usedBytes: storage.capacity.usedBytes, totalBytes: storage.capacity.totalBytes }
      : connected && storage?.capacityRoute === 'system-settings'
        ? { kind: 'route' }
        : connected && descriptor?.capabilities.quota === 'known'
          ? { kind: 'unavailable' }
          : { kind: 'none' };

  const capabilitiesLine =
    descriptor === null
      ? null
      : `${descriptor.capabilities.verification === 'server-checksum' ? 'Server checksum' : 'Verify by download'} · ${
          descriptor.capabilities.resumableUpload ? 'resumable uploads' : 'restarts interrupted uploads'
        }`;

  const primaryLabel = disconnecting
    ? intl.formatMessage(messages.disconnecting)
    : connecting
      ? 'Connecting…'
      : connection === 'checking'
        ? 'Checking…'
        : connection === 'error'
          ? 'Try again'
          : connected
            ? destructiveActions.disconnectProvider.label
            : `Connect ${name}`;

  const onPrimary = (): void => {
    if (connection === 'error') {
      setStatusLoad(null);
      setConnectError(null);
      refresh();
    } else if (connected) {
      beginDisconnect();
    } else {
      changeConnection('connect');
    }
  };

  const disconnectLoad = disconnectPreflight?.targetId === targetId ? disconnectPreflight : null;
  const disconnectResult = disconnectLoad?.state === 'ready' ? disconnectLoad.value : null;

  return (
    <div className="ovl-settings__fields">
      {status?.custodyRequirements?.map((requirement) => (
        <CustodyRequirementBanner
          key={`${requirement.providerId}:${requirement.accountId}`}
          name={providers.find((provider) => provider.id === requirement.providerId)?.label ?? requirement.providerId}
          requirement={requirement}
        />
      ))}

      <ProviderCard
        name={name}
        connection={connection}
        account={status?.accountLabel ?? null}
        capacity={capacity}
        capabilitiesLine={capabilitiesLine}
        message={connectError}
        primaryLabel={primaryLabel}
        primaryVariant={connected ? 'secondary' : 'primary'}
        primaryDisabled={connection === 'checking' || connectionOperation !== null || (!connected && descriptor?.available === false)}
        onPrimary={onPrimary}
        onCapacityRoute={openCapacitySettings}
      />

      <FileProviderSettings />

      <DisconnectProviderDialog
        key={`${targetId ?? 'none'}:${disconnectConfirmation ? 'open' : 'closed'}`}
        open={disconnectConfirmation}
        name={name}
        accountLabel={status?.accountLabel ?? null}
        loading={disconnectLoad?.state === 'loading'}
        result={disconnectResult}
        operation={
          connectionOperation === 'disconnect' || connectionOperation === 'restore' || connectionOperation === 'remove-authorization'
            ? connectionOperation
            : null
        }
        restoreSummary={disconnectRestoreSummary}
        error={connectError}
        onClose={() => setDisconnectConfirmation(false)}
        onRetry={() => {
          if (targetId !== null) void loadDisconnectPreflight(targetId);
        }}
        onDisconnect={() => changeConnection('disconnect')}
        onRestoreAll={restoreBeforeDisconnect}
        onRemoveAuthorization={removeAuthorizationAnyway}
      />

      {!connected && providers.length > 1 && targetId !== null ? (
        <Field label="Backup provider" hint="Choose where encrypted library data is stored.">
          <Segmented
            label="Backup provider"
            value={targetId}
            options={providers.map((provider) => ({ value: provider.id, label: provider.label, disabled: !provider.available }))}
            onChange={(providerId) => {
              setTargetId(providerId);
              const provider = providers.find((candidate) => candidate.id === providerId);
              if (provider !== undefined) onProviderSelection?.(provider);
              setStatusLoad(null);
              setStorageLoad(null);
              setConnectError(null);
            }}
          />
          {providers
            .filter((provider) => !provider.available && provider.unavailableReason !== null)
            .map((provider) => (
              <div key={provider.id} className="ovl-settings__providerMeta">
                {provider.label}: {provider.unavailableReason}
              </div>
            ))}
        </Field>
      ) : null}

      <Field label="Restore from cloud backup" hint="Recover a complete library with its separately saved recovery key.">
        <Button icon="cloud-download" onClick={onRestore}>
          Restore library…
        </Button>
      </Field>

      <OffloadedStorage connection={connection === 'checking' ? 'loading' : connection} selectedPhotoIds={selectedPhotoIds} />

      <Field label="Re-offload after viewing" hint="Keep cloud-only originals temporary unless you choose Keep downloaded.">
        <Switch
          accessibleLabel="Re-offload after viewing"
          checked={settings.reOffloadAfterViewing}
          onChange={(reOffloadAfterViewing) => {
            onPatch({ reOffloadAfterViewing });
          }}
        />
      </Field>

      {connected ? (
        <>
          <Field label="Back up new imports automatically" hint="Encrypts and uploads originals after import.">
            <Switch
              accessibleLabel="Back up new imports automatically"
              checked={settings.autoBackupOnImport}
              onChange={(autoBackupOnImport) => {
                onPatch({ autoBackupOnImport });
              }}
            />
          </Field>
          <Field label="Wi-Fi only" hint="Pause uploads on cellular or metered connections.">
            <Switch
              accessibleLabel="Wi-Fi only"
              checked={settings.wifiOnly}
              onChange={(wifiOnly) => {
                onPatch({ wifiOnly });
              }}
            />
          </Field>
          <Field label="Upload bandwidth limit" hint={bandwidth >= 100 ? 'Unlimited' : `${String(bandwidth)}% of available upload`}>
            <Slider
              label="Upload bandwidth limit"
              value={bandwidth}
              min={10}
              max={100}
              step={5}
              width={130}
              onChange={(bandwidthLimit) => {
                onPatch({ bandwidthLimit });
              }}
            />
          </Field>
        </>
      ) : null}
      <Field label="On import, from card or drive" hint="Move frees space immediately; copy keeps the source untouched.">
        <Segmented
          label="On import, from card or drive"
          value={settings.importMode}
          options={[
            { value: 'copy', label: 'Copy' },
            { value: 'move', label: 'Move' },
          ]}
          onChange={(importMode) => {
            onPatch({ importMode });
          }}
        />
      </Field>
      <Field label="Encrypt originals" hint="Client-side encryption before any upload. Cannot be disabled.">
        <Switch checked disabled accessibleLabel="Encrypt originals" />
      </Field>
    </div>
  );
}
