import { useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { strengthOf } from '../../../shared/crypto/password-strength.js';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { PasswordField } from '../components/PasswordField';
import { Checkbox } from '../components/Checkbox';

import './settings.css';

export type AppPasswordMode = 'set' | 'change' | 'remove' | 'touch-id' | 'anchor-harden' | 'anchor-usability';

const messages = defineMessages({
  anchorHardenTitle: { id: 'appLock.anchorPolicy.harden.title', defaultMessage: 'Enable hardened protection' },
  anchorUsabilityTitle: { id: 'appLock.anchorPolicy.usability.title', defaultMessage: 'Use automatic anchor repair' },
  anchorAck: {
    id: 'appLock.anchorPolicy.harden.ack',
    defaultMessage: 'I saved the new recovery-key export and understand that losing it can make this library inaccessible.',
  },
  anchorHardenNote: {
    id: 'appLock.anchorPolicy.harden.note',
    defaultMessage:
      'A missing or changed local credential anchor will require the recovery-key file you just exported. This can happen after migration, restore, or OS credential-store loss.',
  },
  anchorUsabilityNote: {
    id: 'appLock.anchorPolicy.usability.note',
    defaultMessage:
      'After a valid password or Touch ID, Overlook will repair this Mac’s missing or changed local credential anchor. Malformed credential records still fail closed.',
  },
});

export interface AppPasswordDialogProps {
  readonly mode: AppPasswordMode;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

export function AppPasswordDialog({ mode, onClose, onDone }: AppPasswordDialogProps): ReactElement {
  const intl = useIntl();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const currentOnly = mode === 'remove' || mode === 'touch-id' || mode === 'anchor-harden' || mode === 'anchor-usability';
  const next = currentOnly ? current : password;
  const strength = strengthOf(next);
  const mismatch = mode !== 'remove' && confirm.length > 0 && confirm !== password;
  const canSubmit =
    !busy &&
    (currentOnly
      ? current.length > 0 && (mode !== 'anchor-harden' || acknowledged)
      : password.length >= 8 && password === confirm && strength.score >= 3 && (mode === 'set' || current.length > 0));

  const submit = (): void => {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    const operation = async (): Promise<{
      readonly accepted: boolean;
      readonly reason?: string | null;
      readonly retryAfterMs?: number;
    }> => {
      if (mode === 'set') {
        await window.overlook.appLock.configure({ password });
        return { accepted: true };
      }
      if (mode === 'change') {
        const result = await window.overlook.appLock.changePassword({ currentPassword: current, nextPassword: password });
        return { accepted: result.changed, reason: result.reason, retryAfterMs: result.retryAfterMs };
      }
      if (mode === 'remove') {
        const result = await window.overlook.appLock.remove({ password: current });
        return { accepted: result.removed, reason: result.reason, retryAfterMs: result.retryAfterMs };
      }
      if (mode === 'anchor-harden' || mode === 'anchor-usability') {
        const result = await window.overlook.appLock.setAnchorPolicy({
          password: current,
          policy: mode === 'anchor-harden' ? 'hardened' : 'usability',
          confirmedExport: mode === 'anchor-harden' && acknowledged,
        });
        return { accepted: result.changed, reason: result.reason, retryAfterMs: result.retryAfterMs };
      }
      const result = await window.overlook.appLock.touchIdEnable({ password: current });
      return { accepted: result.enabled, reason: result.reason, retryAfterMs: result.retryAfterMs };
    };
    void operation()
      .then(({ accepted, reason, retryAfterMs }) => {
        if (!accepted) {
          setError(
            reason === 'throttled'
              ? `Try again in ${Math.max(1, Math.ceil((retryAfterMs ?? 0) / 1000))} seconds.`
              : reason === 'not-enrolled'
                ? 'Set up Touch ID in System Settings, then try again.'
                : reason === 'locked-out'
                  ? 'Touch ID is locked. Use your password until macOS makes it available again.'
                  : reason === 'unsigned-build' || reason === 'native-unavailable' || reason === 'unsupported-platform'
                    ? 'Touch ID is unavailable in this build.'
                    : reason === 'unavailable' || reason === 'storage-unavailable'
                      ? 'Touch ID or secure storage is unavailable.'
                      : reason === 'recovery-required'
                        ? 'Recovery is required before this security setting can change.'
                        : reason === 'wrong-password'
                          ? 'The current password is incorrect.'
                          : 'The security change could not be completed safely.',
          );
          return;
        }
        onDone();
      })
      .catch(() => setError('The security change could not be completed safely.'))
      .finally(() => setBusy(false));
  };

  const title =
    mode === 'set'
      ? 'Set app password'
      : mode === 'change'
        ? 'Change app password'
        : mode === 'remove'
          ? 'Remove app password'
          : mode === 'touch-id'
            ? 'Enable Touch ID'
            : mode === 'anchor-harden'
              ? intl.formatMessage(messages.anchorHardenTitle)
              : intl.formatMessage(messages.anchorUsabilityTitle);
  return (
    <Dialog
      open
      title={title}
      icon="lock"
      width={440}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={mode === 'remove' ? 'danger' : 'primary'}
            icon={mode === 'touch-id' ? 'fingerprint' : 'lock'}
            disabled={!canSubmit}
            onClick={submit}
          >
            {busy ? 'Working…' : title}
          </Button>
        </>
      }
    >
      <div className="ovl-key__form">
        <div className="ovl-keynote ovl-keynote--amber">
          <Icon name="shield-check" size={15} color="var(--accent-amber)" />
          <div className="ovl-keynote__body">
            {mode === 'remove'
              ? 'Removing the app password returns custody to this OS keychain. Your separate recovery key is unchanged.'
              : mode === 'touch-id'
                ? 'Confirm your app password. Overlook stores only its unlock key in this Mac’s device-only Keychain, protected by your current Touch ID enrollment.'
                : mode === 'anchor-harden'
                  ? intl.formatMessage(messages.anchorHardenNote)
                  : mode === 'anchor-usability'
                    ? intl.formatMessage(messages.anchorUsabilityNote)
                    : 'While locked, every decrypted original stays sealed — nothing can be viewed, exported, restored, or synced until you unlock.'}
          </div>
        </div>
        {mode === 'change' || currentOnly ? (
          <label>
            <div className="ovl-key__label mono-data">Current password</div>
            <PasswordField
              value={current}
              onChange={setCurrent}
              label="Current password"
              name="app-password"
              autoComplete="current-password"
              autoFocus
            />
          </label>
        ) : null}
        {currentOnly ? null : (
          <>
            <label>
              <div className="ovl-key__label mono-data">New password</div>
              <PasswordField
                value={password}
                onChange={setPassword}
                label="New password"
                name="new-app-password"
                autoComplete="new-password"
                autoFocus={mode === 'set'}
              />
              <div className="ovl-key__meter" role="img" aria-label={`Password strength: ${strength.label || 'none'}`}>
                <div className="ovl-key__meterbars">
                  {Array.from({ length: 5 }, (_, index) => (
                    <span
                      key={index}
                      className="ovl-key__meterbar"
                      style={{ background: index < strength.score ? `var(--accent-${strength.tone})` : 'var(--gray-3)' }}
                    />
                  ))}
                </div>
                <span className="ovl-key__meterlabel" style={{ color: `var(--accent-${strength.tone})` }}>
                  {strength.label}
                </span>
              </div>
            </label>
            <label>
              <div className="ovl-key__label mono-data">Confirm password</div>
              <PasswordField
                value={confirm}
                onChange={setConfirm}
                label="Confirm password"
                name="confirm-app-password"
                autoComplete="new-password"
              />
              {mismatch ? (
                <div className="ovl-key__mismatch">
                  <Icon name="triangle-alert" size={13} />
                  Passwords do not match
                </div>
              ) : null}
            </label>
          </>
        )}
        {mode === 'anchor-harden' ? (
          <Checkbox checked={acknowledged} onChange={setAcknowledged} label={intl.formatMessage(messages.anchorAck)} />
        ) : null}
        <div className="ovl-key__mismatch" role="status" aria-live="polite">
          {error}
        </div>
      </div>
    </Dialog>
  );
}
