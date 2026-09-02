import { useEffect, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { Button } from '../components/Button';
import { Checkbox } from '../components/Checkbox';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { PasswordField } from '../components/PasswordField';
import { useFormats } from '../i18n/use-formats.js';
import { strengthOf } from '../../../shared/crypto/password-strength.js';
import { destructiveActions, REMOVE_KEY_AUTHORIZATION } from '../../../shared/destructive-actions.js';
import type { KeyringEntry } from './keyring-entry.js';

import '../settings/settings.css';

// The keyring ceremonies (#517, ADR-0032 §2). Export: password + confirm +
// the cannot-be-reset acknowledgment, like the recovery backup (#240).
// Import: a .key file + password; the main process refuses anything whose
// reference names no registry row or whose material opens no object.
// Remove: the preflight decides the tier — structural when nothing is
// sealed under the key, irreversible (ADR-0023 Tier D) otherwise, with the
// counts of what becomes locked and the authorization literal on confirm.

export type KeyringDialogMode = 'export' | 'import' | 'remove';

const messages = defineMessages({
  exportTitle: { id: 'keyring.export.title', defaultMessage: 'Export KEY #{id}' },
  importTitle: { id: 'keyring.import.title', defaultMessage: 'Import encryption key' },
  removeTitle: { id: 'keyring.remove.title', defaultMessage: 'Remove KEY #{id}?' },
  cancel: { id: 'keyring.cancel', defaultMessage: 'Cancel' },
  done: { id: 'keyring.done', defaultMessage: 'Done' },
  exportNote: {
    id: 'keyring.export.note',
    defaultMessage: 'This key opens every photo sealed under it. Anyone with the file and the password can read those photos.',
  },
  password: { id: 'keyring.password', defaultMessage: 'Password' },
  exportPassword: { id: 'keyring.export.password', defaultMessage: 'Encrypt key file with password' },
  confirmPassword: { id: 'keyring.export.confirm', defaultMessage: 'Confirm password' },
  mismatch: { id: 'keyring.export.mismatch', defaultMessage: "Passwords don't match." },
  exportAck: { id: 'keyring.export.ack', defaultMessage: 'I understand this password cannot be reset or recovered.' },
  exportAction: { id: 'keyring.export.action', defaultMessage: 'Export key file' },
  exportDone: { id: 'keyring.export.done', defaultMessage: 'Key file saved to {path}.' },
  exportFailed: { id: 'keyring.export.failed', defaultMessage: 'Export failed — nothing was written.' },
  importNote: {
    id: 'keyring.import.note',
    defaultMessage: 'Import a key file exported from another device. Locked photos sealed under it open as soon as the key is verified.',
  },
  chooseFile: { id: 'keyring.import.choose', defaultMessage: 'Choose key file…' },
  importAction: { id: 'keyring.import.action', defaultMessage: 'Verify & import' },
  imported: {
    id: 'keyring.import.imported',
    defaultMessage: 'KEY #{id} imported · {count, plural, =0 {nothing was locked} one {# photo unlocked} other {# photos unlocked}}',
  },
  alreadyPresent: { id: 'keyring.import.alreadyPresent', defaultMessage: 'KEY #{id} is already on this device — nothing changed.' },
  importInvalid: { id: 'keyring.import.invalid', defaultMessage: 'Not an Overlook key file.' },
  importWrongPassword: {
    id: 'keyring.import.wrongPassword',
    defaultMessage: 'Wrong password (or a corrupted file). The password cannot be reset — try again.',
  },
  importMatchesNothing: {
    id: 'keyring.import.matchesNothing',
    defaultMessage: 'This library has never sealed anything under that key — nothing to unlock.',
  },
  importNoObject: {
    id: 'keyring.import.noMatchingObject',
    defaultMessage: 'The password opened the file, but the key does not open any photo it claims to seal. Nothing was installed.',
  },
  importMismatch: {
    id: 'keyring.import.mismatch',
    defaultMessage: 'A different key already holds that reference on this device. Nothing was installed.',
  },
  importFailed: { id: 'keyring.import.failed', defaultMessage: 'Import failed — nothing was installed.' },
  removeChecking: { id: 'keyring.remove.checking', defaultMessage: 'Checking what this key seals…' },
  removeRefusedDatabase: { id: 'keyring.remove.refused.database', defaultMessage: 'KEY #1 also keys the database and cannot be removed.' },
  removeRefusedWrite: { id: 'keyring.remove.refused.write', defaultMessage: 'The write key seals new imports and cannot be removed.' },
  removeRefusedAbsent: { id: 'keyring.remove.refused.absent', defaultMessage: 'This key is not on this device.' },
  removeRefusedMissing: { id: 'keyring.remove.refused.missing', defaultMessage: 'This key is no longer in the registry.' },
  photos: { id: 'keyring.remove.count.photos', defaultMessage: 'Photos' },
  sidecars: { id: 'keyring.remove.count.sidecars', defaultMessage: 'Sidecars' },
  bytes: { id: 'keyring.remove.count.bytes', defaultMessage: 'Sealed' },
  removeAck: {
    id: 'keyring.remove.ack',
    defaultMessage: 'I have an exported copy of this key, or I accept that these photos become locked.',
  },
  removeDone: {
    id: 'keyring.remove.done',
    defaultMessage: 'KEY #{id} removed · {count, plural, =0 {nothing became locked} one {# photo locked} other {# photos locked}}',
  },
  removeFailed: { id: 'keyring.remove.failed', defaultMessage: 'Removal failed — the key is still on this device.' },
});

type Preflight = Awaited<ReturnType<typeof window.overlook.keyring.removePreflight>>;

export interface KeyringDialogProps {
  readonly mode: KeyringDialogMode;
  /** The registry row for export and remove; null for import. */
  readonly entry: KeyringEntry | null;
  readonly onClose: () => void;
}

function Alert({ children }: { readonly children: string }): ReactElement {
  return (
    <div className="ovl-key__mismatch" role="alert">
      <Icon name="triangle-alert" size={12} />
      {children}
    </div>
  );
}

function Done({ children }: { readonly children: string }): ReactElement {
  return (
    <div className="ovl-key__done" data-testid="keyring-done">
      <div className="ovl-key__doneline">
        <Icon name="shield-check" size={16} />
        {children}
      </div>
    </div>
  );
}

export function KeyringDialog({ mode, entry, onClose }: KeyringDialogProps): ReactElement {
  const intl = useIntl();
  const { formatBytes } = useFormats();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ack, setAck] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const id = entry?.id ?? 0;

  useEffect(() => {
    if (mode !== 'remove' || entry === null) return;
    void window.overlook.keyring.removePreflight({ id: entry.id }).then(setPreflight);
  }, [mode, entry]);

  const strength = strengthOf(password);
  const mismatch = confirm.length > 0 && confirm !== password;
  const fail = (message: string) => (): void => {
    setBusy(false);
    setError(message);
  };

  const doExport = (): void => {
    setBusy(true);
    setError(null);
    void window.overlook.keyring
      .export({ id, password })
      .then(({ path }) => {
        setBusy(false);
        if (path !== null) setDone(intl.formatMessage(messages.exportDone, { path }));
      })
      .catch(fail(intl.formatMessage(messages.exportFailed)));
  };

  const doImport = (): void => {
    if (file === null) return;
    setBusy(true);
    setError(null);
    void window.overlook.keyring
      .import({ path: file, password })
      .then((result) => {
        setBusy(false);
        if (result.outcome === 'imported') {
          setDone(intl.formatMessage(messages.imported, { id: String(result.keyId), count: result.unlocked }));
          return;
        }
        if (result.outcome === 'already-present') {
          setDone(intl.formatMessage(messages.alreadyPresent, { id: String(result.keyId) }));
          return;
        }
        const copy = {
          invalid: messages.importInvalid,
          'wrong-password': messages.importWrongPassword,
          'matches-nothing': messages.importMatchesNothing,
          'no-matching-object': messages.importNoObject,
          mismatch: messages.importMismatch,
        };
        setError(intl.formatMessage(copy[result.reason ?? 'invalid']));
      })
      .catch(fail(intl.formatMessage(messages.importFailed)));
  };

  const doRemove = (): void => {
    if (preflight === null) return;
    setBusy(true);
    setError(null);
    const authorization = preflight.tier === 'irreversible' ? { authorization: REMOVE_KEY_AUTHORIZATION } : {};
    void window.overlook.keyring
      .remove({ id, ...authorization })
      .then((result) => {
        setBusy(false);
        if (result.removed) setDone(intl.formatMessage(messages.removeDone, { id: String(id), count: result.locked }));
        else setError(intl.formatMessage(messages.removeFailed));
      })
      .catch(fail(intl.formatMessage(messages.removeFailed)));
  };

  const chooseFile = (): void => {
    void window.overlook.keyring.pickFile().then(({ path }) => {
      if (path !== null) {
        setFile(path);
        setError(null);
      }
    });
  };

  const title =
    mode === 'export'
      ? intl.formatMessage(messages.exportTitle, { id: String(id) })
      : mode === 'import'
        ? intl.formatMessage(messages.importTitle)
        : preflight?.tier === 'irreversible'
          ? destructiveActions.removeEncryptionKey.title
          : intl.formatMessage(messages.removeTitle, { id: String(id) });
  const canExport = password.length >= 8 && password === confirm && strength.score >= 3 && ack && !busy;
  const canImport = file !== null && password.length > 0 && !busy;
  const canRemove = preflight?.allowed === true && (preflight.tier === 'structural' || ack) && !busy;
  const cancel = (
    <Button variant="ghost" onClick={onClose}>
      {intl.formatMessage(messages.cancel)}
    </Button>
  );
  const footer =
    done !== null ? (
      <Button variant="primary" onClick={onClose} data-testid="keyring-dialog-done">
        {intl.formatMessage(messages.done)}
      </Button>
    ) : mode === 'export' ? (
      <>
        {cancel}
        <Button variant="primary" icon="download" disabled={!canExport} onClick={doExport} data-testid="keyring-dialog-export">
          {intl.formatMessage(messages.exportAction)}
        </Button>
      </>
    ) : mode === 'import' ? (
      <>
        {cancel}
        <Button variant="primary" icon="key-round" disabled={!canImport} onClick={doImport} data-testid="keyring-dialog-import">
          {intl.formatMessage(messages.importAction)}
        </Button>
      </>
    ) : (
      <>
        {cancel}
        <Button variant="danger" icon="trash-2" disabled={!canRemove} onClick={doRemove} data-testid="keyring-dialog-remove">
          {preflight?.tier === 'irreversible' ? destructiveActions.removeEncryptionKey.label : destructiveActions.forgetEncryptionKey.label}
        </Button>
      </>
    );

  const refusal =
    preflight === null || preflight.allowed
      ? null
      : intl.formatMessage(
          {
            'database-key': messages.removeRefusedDatabase,
            'write-key': messages.removeRefusedWrite,
            'not-present': messages.removeRefusedAbsent,
            'not-found': messages.removeRefusedMissing,
          }[preflight.reason ?? 'not-found'],
        );

  return (
    <Dialog open title={title} icon={mode === 'remove' ? 'triangle-alert' : 'key-round'} width={440} onClose={onClose} footer={footer}>
      {done !== null ? (
        <Done>{done}</Done>
      ) : mode === 'export' ? (
        <div className="ovl-key__form">
          <div className="ovl-keynote ovl-keynote--amber">
            <Icon name="key-round" size={15} color="var(--accent-amber)" />
            <div className="ovl-keynote__body">{intl.formatMessage(messages.exportNote)}</div>
          </div>
          <div>
            <div className="ovl-key__label mono-data">{intl.formatMessage(messages.exportPassword)}</div>
            <PasswordField value={password} onChange={setPassword} label={intl.formatMessage(messages.exportPassword)} autoFocus />
          </div>
          <div>
            <div className="ovl-key__label mono-data">{intl.formatMessage(messages.confirmPassword)}</div>
            <PasswordField value={confirm} onChange={setConfirm} label={intl.formatMessage(messages.confirmPassword)} />
            {mismatch ? <Alert>{intl.formatMessage(messages.mismatch)}</Alert> : null}
          </div>
          <Checkbox checked={ack} onChange={setAck} label={intl.formatMessage(messages.exportAck)} />
          {error === null ? null : <Alert>{error}</Alert>}
        </div>
      ) : mode === 'import' ? (
        <div className="ovl-key__form">
          <div className="ovl-keynote ovl-keynote--neutral">
            <Icon name="info" size={15} color="var(--text-muted)" />
            <div className="ovl-keynote__body">{intl.formatMessage(messages.importNote)}</div>
          </div>
          <Button variant="secondary" icon="upload" onClick={chooseFile} data-testid="keyring-choose-file">
            {file === null
              ? intl.formatMessage(messages.chooseFile)
              : file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1)}
          </Button>
          <div>
            <div className="ovl-key__label mono-data">{intl.formatMessage(messages.password)}</div>
            <PasswordField value={password} onChange={setPassword} label={intl.formatMessage(messages.password)} />
          </div>
          {error === null ? null : <Alert>{error}</Alert>}
        </div>
      ) : (
        <div className="ovl-key__form" data-testid="keyring-remove-body">
          {preflight === null ? (
            <div className="ovl-keyring__empty">{intl.formatMessage(messages.removeChecking)}</div>
          ) : refusal !== null ? (
            <Alert>{refusal}</Alert>
          ) : (
            <>
              <p>
                {preflight.tier === 'irreversible'
                  ? destructiveActions.removeEncryptionKey.sideEffects
                  : destructiveActions.forgetEncryptionKey.survival}
              </p>
              {preflight.tier === 'irreversible' ? (
                <>
                  <dl className="ovl-keyring__counts mono-data" data-testid="keyring-remove-counts">
                    <dt>{intl.formatMessage(messages.photos)}</dt>
                    <dd>{preflight.usage.photos}</dd>
                    <dt>{intl.formatMessage(messages.sidecars)}</dt>
                    <dd>{preflight.usage.sidecars}</dd>
                    <dt>{intl.formatMessage(messages.bytes)}</dt>
                    <dd>{formatBytes(preflight.usage.bytes)}</dd>
                  </dl>
                  <Checkbox checked={ack} onChange={setAck} label={intl.formatMessage(messages.removeAck)} />
                </>
              ) : null}
            </>
          )}
          {error === null ? null : <Alert>{error}</Alert>}
        </div>
      )}
    </Dialog>
  );
}
