import { useEffect, useState, type ReactElement } from 'react';

import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { Switch } from '../components/Switch';
import { Segmented } from '../components/Segmented';
import { Field } from './Field';
import type { AppSettings } from '../../../shared/settings/settings.js';
import type { KeyDialogMode } from './KeyDialog';
import type { AppPasswordMode } from './AppPasswordDialog';
import { ProtectedAlbumSettings } from '../protected/ProtectedAlbumSettings';
import { DiagnosticsControls } from './DiagnosticsControls';
import { KeyringSection } from '../keyring/KeyringSection';

// Privacy section (#115): honest, factual, mostly locked-on. Face grouping
// ships DISABLED — the mock shows it locked-on, but the feature is deferred
// by design and we don't fake it (conflict recorded on the epic). The
// diagnostics stay local-only pending the backend/data-controller decision;
// the controls expose the exact encrypted queue for review and deletion.

export interface PrivacyPaneProps {
  readonly settings: AppSettings;
  readonly onPatch: (patch: Partial<Pick<AppSettings, 'shareDiagnostics' | 'appLockIdle' | 'lockWhenHidden'>>) => void;
  /** Opens the KeyDialog (#240) in the given mode. */
  readonly onKeyAction: (mode: KeyDialogMode) => void;
  readonly appLockConfigured: boolean;
  readonly onPasswordAction: (mode: AppPasswordMode) => void;
  readonly onLockNow: () => void;
  readonly touchIdStatus: Awaited<ReturnType<typeof window.overlook.appLock.touchIdStatus>> | null;
  readonly touchIdBusy: boolean;
  readonly onTouchIdChange: (enabled: boolean) => void;
  readonly anchorPolicy: 'usability' | 'hardened' | null;
  readonly onAnchorPolicyChange: (policy: 'usability' | 'hardened') => void;
}

export function PrivacyPane({
  settings,
  onPatch,
  onKeyAction,
  appLockConfigured,
  onPasswordAction,
  onLockNow,
  touchIdStatus,
  touchIdBusy,
  onTouchIdChange,
  anchorPolicy,
  onAnchorPolicyChange,
}: PrivacyPaneProps): ReactElement {
  // The recovery row's fingerprint (#240) — the same identifier the
  // KeyDialog shows; '—' while the keystore is unavailable.
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  useEffect(() => {
    void window.overlook.keys
      .status()
      .then(({ fingerprint: value }) => {
        setFingerprint(value);
      })
      .catch(() => {
        setFingerprint(null);
      });
  }, []);
  return (
    <div className="ovl-settings__fields">
      <Field
        label="App password"
        hint={appLockConfigured ? 'Required on launch and after every lock.' : 'Withholds decryption authority until you unlock.'}
      >
        {appLockConfigured ? (
          <div className="ovl-settings__keyactions">
            <Button variant="secondary" onClick={() => onPasswordAction('change')}>
              Change…
            </Button>
            <Button variant="ghost" onClick={() => onPasswordAction('remove')}>
              Remove…
            </Button>
          </div>
        ) : (
          <Button variant="secondary" icon="lock" onClick={() => onPasswordAction('set')}>
            Set password…
          </Button>
        )}
      </Field>
      <Field label="Lock now" hint="Immediately seals the library and clears decrypted caches.">
        <Button variant="secondary" icon="lock" disabled={!appLockConfigured} onClick={onLockNow}>
          Lock now
        </Button>
      </Field>
      <Field label="Auto-lock" hint="Lock after trusted keyboard or pointer input has been idle.">
        <Segmented
          label="Auto-lock timeout"
          disabled={!appLockConfigured}
          value={settings.appLockIdle}
          options={[
            { value: '1', label: '1m' },
            { value: '5', label: '5m' },
            { value: '15', label: '15m' },
            { value: '30', label: '30m' },
            { value: 'never', label: 'Never' },
          ]}
          onChange={(appLockIdle) => onPatch({ appLockIdle })}
        />
      </Field>
      <Field label="Lock when hidden" hint="Also lock when the app is hidden or minimized.">
        <Switch
          accessibleLabel="Lock when hidden"
          checked={settings.lockWhenHidden}
          disabled={!appLockConfigured}
          onChange={(lockWhenHidden) => onPatch({ lockWhenHidden })}
        />
      </Field>
      <Field label="Unlock with Touch ID" hint={touchIdHint(appLockConfigured, touchIdStatus)}>
        <Switch
          accessibleLabel="Unlock with Touch ID"
          checked={touchIdStatus?.enabled ?? false}
          disabled={!appLockConfigured || touchIdBusy || touchIdStatus === null || (!touchIdStatus.available && !touchIdStatus.enabled)}
          onChange={onTouchIdChange}
        />
      </Field>
      <Field
        label="Hardened anchor protection"
        hint="Off repairs this Mac’s local credential anchor after a valid password or Touch ID. On treats an anchor change as recovery and requires a freshly exported recovery key."
      >
        <Switch
          accessibleLabel="Hardened anchor protection"
          checked={anchorPolicy === 'hardened'}
          disabled={!appLockConfigured || anchorPolicy === null}
          onChange={(enabled) => onAnchorPolicyChange(enabled ? 'hardened' : 'usability')}
        />
      </Field>
      <ProtectedAlbumSettings />
      <Field label="End-to-end encryption" hint="Originals and thumbnails are encrypted on this device before leaving it.">
        <Badge tone="green">Always on</Badge>
      </Field>
      <div className="ovl-settings__keyrow" data-testid="recovery-key-row">
        <div>
          <div className="ovl-settings__keytitle">Recovery key</div>
          <div className="ovl-settings__keyhint">
            {appLockConfigured
              ? 'Back up your library key here. Remove the app password before importing a different key; recovery remains available from the lock screen when required.'
              : "Back up your library key to unlock photos on another device. Store it safely — it can't be reset."}
          </div>
          <div className="ovl-settings__keyfp">
            <Icon name="fingerprint" size={13} color="var(--text-faint)" />
            <span className="mono-data">{fingerprint ?? '—'}</span>
          </div>
        </div>
        <div className="ovl-settings__keyactions">
          <Button
            variant="secondary"
            icon="download"
            onClick={() => {
              onKeyAction('backup');
            }}
          >
            Back up…
          </Button>
          <Button
            variant="ghost"
            icon="upload"
            disabled={appLockConfigured}
            onClick={() => {
              onKeyAction('import');
            }}
          >
            Import…
          </Button>
        </div>
      </div>
      <KeyringSection />
      <Field label="Face grouping" hint="Not yet available — will run entirely on-device when it ships.">
        <Switch checked={false} disabled accessibleLabel="Face grouping" />
      </Field>
      <Field
        label="Share diagnostics"
        hint="Anonymous crash reports only — never photo content or metadata. Reporting stays local-only for now."
      >
        <div className="ovl-settings__diagnosticsControl">
          <Switch
            accessibleLabel="Share diagnostics"
            checked={settings.shareDiagnostics}
            onChange={(shareDiagnostics) => {
              onPatch({ shareDiagnostics });
            }}
          />
          <DiagnosticsControls enabled={settings.shareDiagnostics} />
        </div>
      </Field>
    </div>
  );
}

function touchIdHint(appLockConfigured: boolean, status: Awaited<ReturnType<typeof window.overlook.appLock.touchIdStatus>> | null): string {
  if (!appLockConfigured) return 'Set an app password first.';
  if (status === null) return 'Checking this Mac…';
  if (status.reenrollmentRequired && status.available)
    return 'Overlook was updated to its new signed identity. Turn Touch ID on again and confirm your app password.';
  if (status.reenrollmentRequired)
    return 'Your prior Touch ID enrollment belongs to Overlook’s previous app identity. Password unlock remains available.';
  if (status.enabled && status.available) return 'Enabled on this Mac. Your app password always remains available.';
  if (status.enabled) return 'Enabled, but Touch ID is currently unavailable. Use your app password or turn this off.';
  if (status.available) return 'Confirm your app password to opt in on this Mac.';
  switch (status.reason) {
    case 'not-enrolled':
      return 'Set up Touch ID in System Settings first.';
    case 'locked-out':
      return 'Touch ID is locked by macOS. Use your app password.';
    case 'unsigned-build':
      return 'Available only in signed Overlook builds.';
    case 'unsupported-platform':
      return 'Available on supported Macs with Touch ID.';
    case 'native-unavailable':
      return 'This build does not include native Touch ID support.';
    case 'unavailable':
    case null:
      return 'Touch ID or secure storage is unavailable on this Mac.';
  }
}
