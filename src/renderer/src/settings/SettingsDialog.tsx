import { useEffect, useRef, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import type { MessageDescriptor } from 'react-intl';

import { Dialog } from '../components/Dialog';
import { Icon, type IconName } from '../components/Icon';
import { GeneralPane } from './GeneralPane';
import { KeyDialog, type KeyDialogMode } from './KeyDialog';
import { PrivacyPane } from './PrivacyPane';
import { StoragePane } from './StoragePane';
import { RestoreWorkflow } from '../restore/RestoreWorkflow';
import { AppPasswordDialog, type AppPasswordMode } from './AppPasswordDialog';
import type { AppSettings, SettingsPatch } from '../../../shared/settings/settings.js';
import type { ProviderDescriptor } from '../../../shared/backup/provider-descriptor.js';
import { TransferPane } from './TransferPane.js';

import './settings.css';

// SettingsDialog shell (#112): the design's 640px two-pane frame — 160px
// left nav (icon+label rows), right content pane. Storage & Backup is the
// default-open section per the design. The dialog reads the store once on
// open and follows changed pushes — one truth for every pane (#113+).

export type SettingsSection = 'general' | 'storage' | 'transfer' | 'privacy';

export interface SettingsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly selectedPhotoIds?: readonly string[] | undefined;
  readonly onTransfer?: (() => void) | undefined;
  readonly transferEnabled?: boolean | undefined;
  readonly requestedSection?: SettingsSection | undefined;
  readonly onProviderSelection?: ((provider: ProviderDescriptor) => void) | undefined;
  readonly preferredProviderId?: string | null | undefined;
}

const messages = defineMessages({
  title: { id: 'settings.title', defaultMessage: 'Settings' },
  sections: { id: 'settings.nav.label', defaultMessage: 'Settings sections' },
  general: { id: 'settings.nav.general', defaultMessage: 'General' },
  storage: { id: 'settings.nav.storage', defaultMessage: 'Storage & Backup' },
  transfer: { id: 'settings.nav.transfer', defaultMessage: 'Transfer & Sync' },
  privacy: { id: 'settings.nav.privacy', defaultMessage: 'Privacy' },
  restoreTitle: { id: 'settings.restore.title', defaultMessage: 'Restore from cloud backup' },
});

const SECTIONS: readonly { key: SettingsSection; icon: IconName; label: MessageDescriptor }[] = [
  { key: 'general', icon: 'sliders-horizontal', label: messages.general },
  { key: 'storage', icon: 'cloud', label: messages.storage },
  { key: 'transfer', icon: 'refresh-cw', label: messages.transfer },
  { key: 'privacy', icon: 'shield-check', label: messages.privacy },
];

export function SettingsDialog({
  open,
  onClose,
  selectedPhotoIds = [],
  onTransfer,
  transferEnabled = false,
  requestedSection,
  onProviderSelection,
  preferredProviderId,
}: SettingsDialogProps): ReactElement | null {
  const intl = useIntl();
  const [section, setSection] = useState<SettingsSection>(
    requestedSection === 'transfer' && !transferEnabled ? 'storage' : (requestedSection ?? 'storage'),
  );
  const paneRef = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // Recovery-key dialog (#240): layered over Settings, per the mock.
  const [keyMode, setKeyMode] = useState<KeyDialogMode | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [passwordMode, setPasswordMode] = useState<AppPasswordMode | null>(null);
  const [appLockConfigured, setAppLockConfigured] = useState(false);
  const [touchIdStatus, setTouchIdStatus] = useState<Awaited<ReturnType<typeof window.overlook.appLock.touchIdStatus>> | null>(null);
  const [touchIdBusy, setTouchIdBusy] = useState(false);

  useEffect(() => {
    if (!open || requestedSection === undefined) return;
    const availableSection = requestedSection === 'transfer' && !transferEnabled ? 'storage' : requestedSection;
    setSection((current) => {
      if (current === availableSection) return current;
      if (paneRef.current !== null) paneRef.current.scrollTop = 0;
      return availableSection;
    });
  }, [open, requestedSection, transferEnabled]);

  useEffect(() => {
    if (!open) {
      return;
    }
    let active = true;
    let changed = false;
    const unsubscribe = window.overlook.settings.onChanged((payload) => {
      changed = true;
      setSettings(payload.settings);
    });
    void window.overlook.settings.get().then((response) => {
      if (active && !changed) setSettings(response.settings);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const sync = (state: string): void => setAppLockConfigured(state === 'unlocked');
    void window.overlook.appLock.status().then(({ state }) => sync(state));
    return window.overlook.appLock.onChanged(({ state }) => sync(state));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void window.overlook.appLock.touchIdStatus().then(setTouchIdStatus);
    return window.overlook.appLock.onTouchIdChanged((status) => {
      setTouchIdStatus(status);
      setTouchIdBusy(false);
    });
  }, [open]);

  if (!open) {
    return null;
  }

  const patch = (value: SettingsPatch): void => {
    void window.overlook.settings.set({ patch: value }).then((response) => {
      setSettings(response.settings);
    });
  };

  const selectSection = (nextSection: SettingsSection): void => {
    if (nextSection === activeSection) return;
    if (paneRef.current !== null) paneRef.current.scrollTop = 0;
    setSection(nextSection);
  };
  const activeSection = section === 'transfer' && !transferEnabled ? 'storage' : section;

  return (
    <Dialog
      open
      title={intl.formatMessage(messages.title)}
      icon="settings-2"
      width={640}
      bodyClassName="ovl-dialog__body--settings"
      onClose={onClose}
    >
      <div className="ovl-settings" data-testid="settings-dialog">
        <div
          className="ovl-settings__nav"
          role="tablist"
          aria-orientation="vertical"
          tabIndex={-1}
          aria-label={intl.formatMessage(messages.sections)}
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
            const current = tabs.findIndex((tab) => tab === document.activeElement);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : event.key === 'ArrowDown'
                    ? (current + 1) % tabs.length
                    : (current - 1 + tabs.length) % tabs.length;
            const tab = tabs[next];
            if (tab === undefined) return;
            event.preventDefault();
            tab.focus();
            tab.click();
          }}
        >
          {SECTIONS.filter(({ key }) => key !== 'transfer' || transferEnabled).map(({ key, icon, label }) => {
            const current = key === activeSection;
            return (
              <button
                key={key}
                id={`settings-tab-${key}`}
                type="button"
                role="tab"
                className={`ovl-settings__navrow${current ? ' ovl-settings__navrow--active' : ''}`}
                aria-selected={current}
                aria-controls="settings-panel"
                tabIndex={current ? 0 : -1}
                onClick={() => {
                  selectSection(key);
                }}
              >
                <Icon name={icon} size={14} color={current ? 'var(--accent-cyan)' : 'var(--text-faint)'} />
                <span>{intl.formatMessage(label)}</span>
              </button>
            );
          })}
        </div>
        <div
          ref={paneRef}
          id="settings-panel"
          className="ovl-settings__pane"
          role="tabpanel"
          aria-labelledby={`settings-tab-${activeSection}`}
          data-testid="settings-pane"
          data-section={activeSection}
        >
          {settings === null ? null : activeSection === 'general' ? (
            <GeneralPane settings={settings} onPatch={patch} />
          ) : activeSection === 'storage' ? (
            <StoragePane
              settings={settings}
              selectedPhotoIds={selectedPhotoIds}
              onPatch={patch}
              onRestore={() => setRestoreOpen(true)}
              onProviderSelection={onProviderSelection}
              preferredProviderId={preferredProviderId}
            />
          ) : activeSection === 'transfer' && transferEnabled ? (
            <TransferPane onOpen={onTransfer} />
          ) : (
            <PrivacyPane
              settings={settings}
              onPatch={patch}
              onKeyAction={setKeyMode}
              appLockConfigured={appLockConfigured}
              onPasswordAction={setPasswordMode}
              onLockNow={() => void window.overlook.appLock.lockNow()}
              touchIdStatus={touchIdStatus}
              touchIdBusy={touchIdBusy}
              onTouchIdChange={(enabled) => {
                if (enabled) {
                  setPasswordMode('touch-id');
                  return;
                }
                setTouchIdBusy(true);
                void window.overlook.appLock
                  .touchIdDisable()
                  .then(({ disabled }) => {
                    if (!disabled) setTouchIdBusy(false);
                  })
                  .catch(() => setTouchIdBusy(false));
              }}
            />
          )}
        </div>
      </div>
      {keyMode !== null ? (
        <KeyDialog
          open
          mode={keyMode}
          onClose={() => {
            setKeyMode(null);
          }}
        />
      ) : null}
      {restoreOpen ? (
        <Dialog
          open
          title={intl.formatMessage(messages.restoreTitle)}
          icon="cloud-download"
          width={640}
          onClose={() => setRestoreOpen(false)}
        >
          <RestoreWorkflow context="settings" />
        </Dialog>
      ) : null}
      {passwordMode === null ? null : (
        <AppPasswordDialog mode={passwordMode} onClose={() => setPasswordMode(null)} onDone={() => setPasswordMode(null)} />
      )}
    </Dialog>
  );
}
