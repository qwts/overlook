import { useEffect, useState, type DragEvent, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Checkbox } from '../components/Checkbox';
import { Dialog } from '../components/Dialog';
import { Icon, type IconName } from '../components/Icon';
import { PasswordField } from '../components/PasswordField';
import { strengthOf } from '../../../shared/crypto/password-strength.js';
import { CopyableValue } from '../components/CopyableValue';
import { admitRecoveryKeyDrop, type RecoveryKeyDropFailure } from '../recovery-key-drop';

import './settings.css';

// KeyDialog (#240) — the design's recovery-key backup/import flows over the
// real keys IPC. Backup: password + confirm (strength meter, mock-verbatim
// heuristic), the explicit cannot-be-reset acknowledgment gating export,
// then the saved-file card + store-it-safely warning. Import: a .key
// file (picker or drop) + password → unlock & install. Local key
// management, independent of the selected cloud provider (README §7b).

export type KeyDialogMode = 'backup' | 'import';

const messages = defineMessages({
  copyFingerprint: { id: 'settings.keys.copyFingerprint', defaultMessage: 'library key fingerprint' },
  copyFileName: { id: 'settings.keys.copyFileName', defaultMessage: 'recovery key filename' },
  dropEmpty: { id: 'recoveryKey.drop.empty', defaultMessage: 'Drop one Overlook recovery-key file.' },
  dropMultiple: { id: 'recoveryKey.drop.multiple', defaultMessage: 'Choose or drop one recovery-key file at a time.' },
  dropWrongType: { id: 'recoveryKey.drop.wrongType', defaultMessage: 'Choose an Overlook .key recovery file.' },
  dropUnavailable: {
    id: 'recoveryKey.drop.unavailable',
    defaultMessage: 'This dropped file has no readable local path. Use the file picker instead.',
  },
});

function dropFailureMessage(reason: RecoveryKeyDropFailure, formatMessage: ReturnType<typeof useIntl>['formatMessage']): string {
  switch (reason) {
    case 'empty':
      return formatMessage(messages.dropEmpty);
    case 'multiple':
      return formatMessage(messages.dropMultiple);
    case 'wrong-type':
      return formatMessage(messages.dropWrongType);
    case 'unavailable':
      return formatMessage(messages.dropUnavailable);
  }
}

export interface KeyDialogProps {
  readonly open: boolean;
  readonly mode: KeyDialogMode;
  readonly onClose: () => void;
  /** Green completion toasts ride the shell's toast host when wired. */
  readonly onToast?: ((title: string) => void) | undefined;
  readonly onExported?: (() => void) | undefined;
}

function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? path : path.slice(cut + 1);
}

function Note({
  tone,
  icon,
  children,
}: {
  tone: 'amber' | 'green' | 'neutral';
  icon: IconName;
  children: ReactElement | string;
}): ReactElement {
  return (
    <div className={`ovl-keynote ovl-keynote--${tone}`}>
      <Icon
        name={icon}
        size={15}
        color={tone === 'amber' ? 'var(--accent-amber)' : tone === 'green' ? 'var(--accent-green)' : 'var(--text-muted)'}
      />
      <div className="ovl-keynote__body">{children}</div>
    </div>
  );
}

function FingerprintRow({ fingerprint }: { fingerprint: string | null }): ReactElement {
  const intl = useIntl();
  return (
    <div className="ovl-keyfp" data-testid="key-fingerprint">
      <Icon name="fingerprint" size={16} color="var(--text-faint)" />
      <div className="ovl-keyfp__body">
        <div className="ovl-keyfp__label mono-data">Library key</div>
        {fingerprint === null ? (
          <div className="ovl-keyfp__value mono-data">—</div>
        ) : (
          <CopyableValue value={fingerprint} label={intl.formatMessage(messages.copyFingerprint)} textClassName="ovl-keyfp__value" />
        )}
      </div>
      <Badge tone="green">Active</Badge>
    </div>
  );
}

export function KeyDialog({ open, mode, onClose, onToast, onExported }: KeyDialogProps): ReactElement | null {
  const intl = useIntl();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ack, setAck] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [installedFp, setInstalledFp] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  const isBackup = mode === 'backup';
  useEffect(() => {
    if (!open || !isBackup) {
      return;
    }
    void window.overlook.keys
      .status()
      .then(({ fingerprint: value }) => {
        setFingerprint(value);
      })
      .catch(() => {
        setFingerprint(null);
      });
  }, [open, isBackup]);

  if (!open) {
    return null;
  }

  const done = isBackup ? savedPath !== null : installedFp !== null;
  const strength = strengthOf(password);
  const mismatch = confirm.length > 0 && confirm !== password;
  // Length floor mirrors the main-side schema (security review P3-1) — a
  // 7-char three-class password can score Fair but still can't seal.
  const canBackup = password.length >= 8 && password === confirm && strength.score >= 3 && ack && !busy;
  const canImport = file !== null && password.length > 0 && !busy;

  const doBackup = (): void => {
    setBusy(true);
    setError(null);
    void window.overlook.keys
      .export({ password })
      .then(({ path }) => {
        setBusy(false);
        if (path === null) {
          return; // save dialog cancelled — stay on the form
        }
        setSavedPath(path);
        onToast?.('Key backup saved');
        onExported?.();
      })
      .catch(() => {
        setBusy(false);
        setError('Export failed — nothing was written.');
      });
  };

  const doImport = (): void => {
    if (file === null) {
      return;
    }
    setBusy(true);
    setError(null);
    void window.overlook.keys
      .import({ path: file, password })
      .then((result) => {
        setBusy(false);
        if (result.installed) {
          setInstalledFp(result.fingerprint);
          onToast?.('Key imported');
          return;
        }
        setError(
          result.reason === 'wrong-password'
            ? 'Wrong password (or a corrupted file). The password cannot be reset — try again.'
            : result.reason === 'mismatch'
              ? "This key doesn't match this device's library."
              : result.reason === 'no-library'
                ? 'No library to unlock here yet — restore the library files first, then import the key.'
                : 'Not a recovery key file.',
        );
      })
      .catch(() => {
        setBusy(false);
        setError('Import failed — nothing was installed.');
      });
  };

  const chooseFile = (): void => {
    void window.overlook.keys.pickFile().then(({ path }) => {
      if (path !== null) {
        setFile(path);
        setError(null);
      }
    });
  };
  const onDropFile = (event: DragEvent): void => {
    event.preventDefault();
    const admission = admitRecoveryKeyDrop(event.dataTransfer.files, window.overlook.import.pathForFile);
    if (admission.reason !== null) {
      setFile(null);
      setError(dropFailureMessage(admission.reason, intl.formatMessage));
      return;
    }
    setFile(admission.path);
    setError(null);
  };

  return (
    <Dialog
      open
      title={isBackup ? 'Back up encryption key' : 'Import encryption key'}
      icon={isBackup ? 'shield-check' : 'key-round'}
      width={440}
      onClose={onClose}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : isBackup ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" icon="download" disabled={!canBackup} onClick={doBackup}>
              Export key backup
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" icon="key-round" disabled={!canImport} onClick={doImport}>
              Unlock &amp; import
            </Button>
          </>
        )
      }
    >
      {isBackup ? (
        savedPath !== null ? (
          <div className="ovl-key__done">
            <div className="ovl-key__doneline">
              <Icon name="shield-check" size={16} />
              Key backup saved.
            </div>
            <div className="ovl-key__filecard">
              <Icon name="file-key" size={16} color="var(--accent-cyan)" />
              <div className="ovl-key__filebody">
                <CopyableValue
                  value={baseName(savedPath)}
                  label={intl.formatMessage(messages.copyFileName)}
                  className="ovl-key__fileCopy"
                  textClassName="ovl-key__filename"
                />
                <div className="ovl-key__filemeta mono-data">AES-256 · password-protected</div>
              </div>
            </div>
            <Note tone="amber" icon="triangle-alert">
              Keep this file and its password apart, and store both offline. Overlook can't recover your photos without them.
            </Note>
          </div>
        ) : (
          <div className="ovl-key__form">
            <Note tone="amber" icon="key-round">
              <>
                This key decrypts every original in your library. Anyone with the file <b>and</b> the password can read your photos — choose
                a password you don't use anywhere else.
              </>
            </Note>
            <FingerprintRow fingerprint={fingerprint} />
            <div>
              <div className="ovl-key__label mono-data">Encrypt backup with password</div>
              <PasswordField
                value={password}
                onChange={setPassword}
                label="Encrypt backup with password"
                placeholder="New password"
                autoFocus
              />
              {password !== '' ? (
                <div className="ovl-key__meter" data-testid="strength-meter">
                  <div className="ovl-key__meterbars">
                    {[0, 1, 2, 3, 4].map((index) => (
                      <div
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
              ) : null}
            </div>
            <div>
              <div className="ovl-key__label mono-data">Confirm password</div>
              <PasswordField value={confirm} onChange={setConfirm} label="Confirm password" placeholder="Re-enter password" />
              {mismatch ? (
                <div className="ovl-key__mismatch" role="alert">
                  <Icon name="x" size={12} />
                  Passwords don't match.
                </div>
              ) : null}
            </div>
            <Checkbox checked={ack} onChange={setAck} label="I understand this password cannot be reset or recovered." />
            {error !== null ? (
              <div className="ovl-key__mismatch" role="alert">
                <Icon name="triangle-alert" size={12} />
                {error}
              </div>
            ) : null}
          </div>
        )
      ) : installedFp !== null ? (
        <div className="ovl-key__done">
          <div className="ovl-key__doneline">
            <Icon name="shield-check" size={16} />
            Key unlocked and installed.
          </div>
          <FingerprintRow fingerprint={installedFp} />
          <Note tone="green" icon="lock">
            This device can now decrypt originals from this library. Encrypted photos unlock on the next launch.
          </Note>
        </div>
      ) : (
        <div className="ovl-key__form">
          <Note tone="neutral" icon="info">
            Import a recovery key to unlock a library backed up from another device. Your photos stay encrypted until the matching key is
            installed.
          </Note>
          <div>
            <div className="ovl-key__label mono-data">Recovery key file</div>
            {file !== null ? (
              <div className="ovl-key__filecard" data-testid="key-file-card">
                <Icon name="file-key" size={16} color="var(--accent-cyan)" />
                <div className="ovl-key__filebody">
                  <CopyableValue
                    value={baseName(file)}
                    label={intl.formatMessage(messages.copyFileName)}
                    className="ovl-key__fileCopy"
                    textClassName="ovl-key__filename"
                  />
                  <div className="ovl-key__filemeta mono-data">AES-256 · password-protected</div>
                </div>
                <button
                  type="button"
                  className="ovl-key__clear"
                  aria-label="Clear key file"
                  onClick={() => {
                    setFile(null);
                  }}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="ovl-key__dropzone"
                data-overlook-file-drop-target="recovery-key"
                onClick={chooseFile}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'copy';
                }}
                onDrop={onDropFile}
              >
                <Icon name="upload" size={20} color="var(--text-faint)" />
                <div className="ovl-key__droptitle">Choose or drop a .key file</div>
                <div className="ovl-key__drophint mono-data">overlook-recovery.key</div>
              </button>
            )}
          </div>
          <div>
            <div className="ovl-key__label mono-data">Password</div>
            <PasswordField value={password} onChange={setPassword} label="Password" placeholder="Backup password" />
          </div>
          {error !== null ? (
            <div className="ovl-key__mismatch" role="alert">
              <Icon name="triangle-alert" size={12} />
              {error}
            </div>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
