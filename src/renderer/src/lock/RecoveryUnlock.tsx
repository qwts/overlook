import { useState, type ReactElement } from 'react';

import { strengthOf } from '../../../shared/crypto/password-strength.js';
import { Button } from '../components/Button.js';
import { PasswordField } from '../components/PasswordField.js';

function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut < 0 ? path : path.slice(cut + 1);
}

export function RecoveryUnlock(): ReactElement {
  const [path, setPath] = useState<string | null>(null);
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const strength = strengthOf(nextPassword);
  const ready =
    path !== null && recoveryPassword.length > 0 && nextPassword.length >= 8 && nextPassword === confirm && strength.score >= 3 && !busy;

  const recover = (): void => {
    if (!ready || path === null) return;
    setBusy(true);
    setError('');
    void window.overlook.appLock
      .recover({ path, recoveryPassword, nextPassword })
      .then((result) => {
        if (result.recovered) return;
        setError(
          result.reason === 'wrong-password'
            ? 'The recovery-key password is incorrect.'
            : result.reason === 'mismatch'
              ? 'That recovery key belongs to another library.'
              : 'Choose a valid Overlook recovery key.',
        );
      })
      .catch(() => setError('Recovery could not complete safely.'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="ovl-lock-recovery">
      <p className="ovl-lock-screen__recovery">
        Use the separately exported recovery key for this library, then establish a new app password on this device.
      </p>
      <Button
        variant="secondary"
        icon="file-key"
        onClick={() => void window.overlook.appLock.pickRecovery().then(({ path: picked }) => setPath(picked))}
      >
        {path === null ? 'Choose recovery key…' : baseName(path)}
      </Button>
      <PasswordField
        value={recoveryPassword}
        onChange={setRecoveryPassword}
        label="Recovery-key password"
        placeholder="Recovery-key password"
        name="recovery-key-password"
        autoComplete="current-password"
      />
      <PasswordField
        value={nextPassword}
        onChange={setNextPassword}
        label="New app password"
        placeholder="New app password"
        name="new-app-password"
        autoComplete="new-password"
      />
      <PasswordField
        value={confirm}
        onChange={setConfirm}
        label="Confirm new app password"
        placeholder="Confirm password"
        name="confirm-app-password"
        autoComplete="new-password"
      />
      <Button variant="primary" icon="shield-check" disabled={!ready} onClick={recover}>
        {busy ? 'Recovering…' : 'Establish new password'}
      </Button>
      <div className="ovl-lock-screen__status" role="status" aria-live="polite">
        {error}
      </div>
    </div>
  );
}
