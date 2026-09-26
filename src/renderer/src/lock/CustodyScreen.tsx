import { useState, type FormEvent, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { LibraryCustodyState } from '../../../shared/library/custody.js';
import { Button } from '../components/Button.js';
import { Icon } from '../components/Icon.js';
import { PasswordField } from '../components/PasswordField.js';
import { TitleBar } from '../components/TitleBar.js';

import './lock-screen.css';

const messages = defineMessages({
  title: { id: 'custody.unwrap.title', defaultMessage: 'Library can’t be opened' },
  unwrapFailed: {
    id: 'custody.unwrap.failed',
    defaultMessage:
      'This Mac cannot unwrap the library’s master key. The photos are still in the library. Import the exported recovery key, or switch to another library.',
  },
  malformed: {
    id: 'custody.unwrap.malformed',
    defaultMessage: 'The stored master key is damaged. Import the exported recovery key, or switch to another library.',
  },
  keychainUnavailable: {
    id: 'custody.unwrap.keychain',
    defaultMessage:
      'The OS keychain is unavailable, so Overlook will not open this library. Switch to another library, or try again when the keychain is available.',
  },
  password: { id: 'custody.unwrap.password', defaultMessage: 'Recovery key password' },
  choose: { id: 'custody.unwrap.choose', defaultMessage: 'Choose recovery key' },
  import: { id: 'custody.unwrap.import', defaultMessage: 'Import recovery key' },
  importing: { id: 'custody.unwrap.importing', defaultMessage: 'Importing…' },
  switchLibrary: { id: 'custody.unwrap.switch', defaultMessage: 'Switch library' },
  wrongPassword: {
    id: 'custody.unwrap.wrongPassword',
    defaultMessage: 'Wrong password (or a corrupted file). The password cannot be reset — try again.',
  },
  mismatch: { id: 'custody.unwrap.mismatch', defaultMessage: 'This key doesn’t match this library.' },
  noLibrary: {
    id: 'custody.unwrap.noLibrary',
    defaultMessage: 'No library to unlock here yet — restore the library files first, then import the key.',
  },
  invalid: { id: 'custody.unwrap.invalid', defaultMessage: 'Not a recovery key file.' },
  failed: { id: 'custody.unwrap.importFailed', defaultMessage: 'Import failed — nothing was installed.' },
});

export interface CustodyScreenProps {
  readonly platform: string;
  readonly state: Exclude<LibraryCustodyState, 'ok'>;
  readonly onRecovered: () => void;
  readonly onSwitchLibrary: () => void;
}

export function CustodyScreen({ platform, state, onRecovered, onSwitchLibrary }: CustodyScreenProps): ReactElement {
  const intl = useIntl();
  const [file, setFile] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const detail =
    state === 'malformed' ? messages.malformed : state === 'keychain-unavailable' ? messages.keychainUnavailable : messages.unwrapFailed;

  const choose = (): void => {
    void window.overlook.keys.pickFile().then(({ path }) => {
      if (path === null) return;
      setFile(path);
      setError('');
    });
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (file === null || password === '' || busy || state === 'keychain-unavailable') return;
    setBusy(true);
    setError('');
    void window.overlook.keys
      .import({ path: file, password })
      .then((result) => {
        setBusy(false);
        if (result.installed) {
          onRecovered();
          return;
        }
        setError(
          intl.formatMessage(
            result.reason === 'wrong-password'
              ? messages.wrongPassword
              : result.reason === 'mismatch'
                ? messages.mismatch
                : result.reason === 'no-library'
                  ? messages.noLibrary
                  : messages.invalid,
          ),
        );
      })
      .catch(() => {
        setBusy(false);
        setError(intl.formatMessage(messages.failed));
      });
  };

  return (
    <div className="ovl-lock-screen" data-testid="custody-screen">
      <TitleBar
        platform={platform}
        onMinimize={() => void window.overlook.minimizeWindow()}
        onToggleMaximize={() => void window.overlook.toggleMaximizeWindow()}
        onClose={() => void window.overlook.closeWindow()}
      />
      <main className="ovl-lock-screen__stage">
        <form className="ovl-lock-screen__card" onSubmit={submit} aria-labelledby="custody-screen-title">
          <div className="ovl-lock-screen__mark" aria-hidden="true">
            <Icon name="key-round" size={20} color="var(--accent-iris)" />
          </div>
          <h1 id="custody-screen-title">{intl.formatMessage(messages.title)}</h1>
          <p>{intl.formatMessage(detail)}</p>
          {file === null ? null : <p className="mono-data">{file}</p>}
          {state === 'keychain-unavailable' ? null : (
            <>
              <Button type="button" variant="secondary" onClick={choose}>
                {intl.formatMessage(messages.choose)}
              </Button>
              <PasswordField
                value={password}
                onChange={setPassword}
                label={intl.formatMessage(messages.password)}
                name="recovery-key-password"
                autoComplete="off"
              />
              <Button type="submit" variant="primary" size="lg" disabled={file === null || password === '' || busy}>
                {busy ? intl.formatMessage(messages.importing) : intl.formatMessage(messages.import)}
              </Button>
            </>
          )}
          {error === '' ? null : (
            <p role="alert" data-testid="custody-error">
              {error}
            </p>
          )}
          <Button type="button" variant="ghost" onClick={onSwitchLibrary}>
            {intl.formatMessage(messages.switchLibrary)}
          </Button>
        </form>
      </main>
    </div>
  );
}
