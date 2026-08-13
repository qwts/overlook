import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { Button } from '../components/Button.js';
import { Icon } from '../components/Icon.js';
import { PasswordField } from '../components/PasswordField.js';
import { TitleBar } from '../components/TitleBar.js';
import { commandById } from '../../../shared/commands/registry.js';
import { RecoveryUnlock } from './RecoveryUnlock.js';

import './lock-screen.css';

const messages = defineMessages({
  retryCountdown: { id: 'lock.retryCountdown', defaultMessage: 'Try again in {seconds}s' },
  attemptsRemaining: {
    id: 'lock.attemptsRemaining',
    defaultMessage: '{count, plural, one {# attempt} other {# attempts}} remaining before recovery',
  },
});

export interface LockScreenProps {
  readonly platform: string;
  readonly state: 'locked' | 'unlocking' | 'locking' | 'recovery-required';
  readonly retryAfterMs: number;
  readonly attemptsRemaining: number;
  readonly onSwitchLibrary: () => void;
}

export function LockScreen({
  platform,
  state,
  retryAfterMs,
  attemptsRemaining: initialAttempts,
  onSwitchLibrary,
}: LockScreenProps): ReactElement {
  const intl = useIntl();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [deadline, setDeadline] = useState(() => Date.now() + retryAfterMs);
  const [clock, setClock] = useState(() => Date.now());
  const [touchId, setTouchId] = useState<Awaited<ReturnType<typeof window.overlook.appLock.touchIdStatus>> | null>(null);
  const [touchIdBusy, setTouchIdBusy] = useState(false);
  const [attemptState, setAttemptState] = useState({ lockState: state, authoritative: initialAttempts, remaining: initialAttempts });
  if (attemptState.lockState !== state || attemptState.authoritative !== initialAttempts) {
    setAttemptState({ lockState: state, authoritative: initialAttempts, remaining: initialAttempts });
  }
  const attemptsRemaining = Math.min(initialAttempts, attemptState.remaining);
  const busy = state === 'unlocking' || state === 'locking';

  useEffect(() => {
    if (deadline <= Date.now()) return;
    const timer = setInterval(() => setClock(Date.now()), 250);
    return () => clearInterval(timer);
  }, [deadline]);

  useEffect(() => {
    void window.overlook.appLock.touchIdStatus().then(setTouchId);
    return window.overlook.appLock.onTouchIdChanged(setTouchId);
  }, []);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (password === '' || busy || deadline > clock || state === 'recovery-required') return;
    setError('');
    void window.overlook.appLock.unlock({ password }).then((result) => {
      if (result.ok) {
        setPassword('');
        return;
      }
      setPassword('');
      setDeadline(Date.now() + result.retryAfterMs);
      setAttemptState({ lockState: state, authoritative: initialAttempts, remaining: result.attemptsRemaining });
      setClock(Date.now());
      setError(
        result.reason === 'throttled'
          ? 'Try again after the security delay.'
          : result.reason === 'library-in-use'
            ? 'This library is open in another Overlook instance. Close it there, then try again.'
            : result.reason === 'recovery-required'
              ? 'This library requires its exported recovery key.'
              : result.reason === 'storage-unavailable'
                ? 'Secure storage is unavailable. Check the operating system credential store, then try again.'
                : 'That password did not unlock this library.',
      );
    });
  };

  const unlockWithTouchId = (): void => {
    if (busy || touchIdBusy || touchId?.enabled !== true || !touchId.available) return;
    setError('');
    setTouchIdBusy(true);
    void window.overlook.appLock
      .touchIdUnlock()
      .then((result) => {
        if (result.ok) return;
        const now = Date.now();
        setDeadline(now + result.retryAfterMs);
        setClock(now);
        setAttemptState({ lockState: state, authoritative: initialAttempts, remaining: result.attemptsRemaining });
        setError(touchIdError(result.reason ?? 'unavailable'));
        if (result.reason === 'enrollment-changed' || result.reason === 'not-enabled') {
          void window.overlook.appLock.touchIdStatus().then(setTouchId);
        }
      })
      .catch(() => setError('Touch ID could not be used. Enter your app password.'))
      .finally(() => setTouchIdBusy(false));
  };

  const recoveryRequired = state === 'recovery-required';
  const remainingMs = Math.max(0, deadline - clock);
  const waitSeconds = Math.ceil(remainingMs / 1000);
  return (
    <div className="ovl-lock-screen" data-testid="lock-screen">
      <TitleBar
        platform={platform}
        onMinimize={() => void window.overlook.minimizeWindow()}
        onToggleMaximize={() => void window.overlook.toggleMaximizeWindow()}
        onClose={() => void window.overlook.closeWindow()}
      />
      <main className="ovl-lock-screen__stage">
        <form className="ovl-lock-screen__card" onSubmit={submit} aria-labelledby="lock-screen-title">
          <div className="ovl-lock-screen__mark" aria-hidden="true">
            <Icon name="lock" size={20} color="var(--accent-iris)" />
          </div>
          <div className="ovl-lock-screen__wordmark mono-data">Overlook</div>
          <h1 id="lock-screen-title">{recoveryRequired ? 'Recovery required' : 'Library locked'}</h1>
          {recoveryRequired ? (
            <RecoveryUnlock />
          ) : (
            <>
              {touchId?.enabled ? (
                <>
                  <Button
                    type="button"
                    variant="primary"
                    size="lg"
                    icon="fingerprint"
                    className="ovl-lock-screen__unlock"
                    disabled={busy || touchIdBusy || !touchId.available}
                    onClick={unlockWithTouchId}
                  >
                    {busy || touchIdBusy ? 'Checking Touch ID…' : touchId.available ? 'Unlock with Touch ID' : 'Touch ID unavailable'}
                  </Button>
                  <div className="ovl-lock-screen__divider">
                    <span>or use app password</span>
                  </div>
                </>
              ) : null}
              <PasswordField
                value={password}
                onChange={setPassword}
                label="App password"
                placeholder="Password"
                name="app-password"
                autoComplete="current-password"
                autoFocus
              />
              <Button
                type="submit"
                variant="primary"
                size="lg"
                icon="lock"
                className="ovl-lock-screen__unlock"
                disabled={password === '' || busy || remainingMs > 0}
                aria-describedby={remainingMs > 0 ? 'lock-screen-retry-countdown' : undefined}
              >
                {busy ? 'Unlocking…' : 'Unlock'}
              </Button>
              {remainingMs > 0 ? (
                <div id="lock-screen-retry-countdown" className="mono-data">
                  {intl.formatMessage(messages.retryCountdown, { seconds: waitSeconds })}
                </div>
              ) : null}
              <div className="mono-data" data-testid="app-lock-attempts-remaining">
                {intl.formatMessage(messages.attemptsRemaining, { count: attemptsRemaining })}
              </div>
            </>
          )}
          {recoveryRequired ? null : (
            <div className="ovl-lock-screen__status" role="status" aria-live="polite">
              {error}
            </div>
          )}
          <Button
            type="button"
            variant="secondary"
            icon="images"
            className="ovl-lock-screen__unlock"
            disabled={busy}
            onClick={onSwitchLibrary}
          >
            {intl.formatMessage(commandById('library.switch').label)}
          </Button>
          <div className="ovl-lock-screen__seal mono-data">
            <Icon name="shield-check" size={13} />
            Decrypted originals stay sealed while locked
          </div>
        </form>
      </main>
    </div>
  );
}

function touchIdError(reason: NonNullable<Awaited<ReturnType<typeof window.overlook.appLock.touchIdUnlock>>['reason']>): string {
  switch (reason) {
    case 'cancelled':
      return 'Touch ID was cancelled. Try again or enter your app password.';
    case 'failed':
      return 'Touch ID did not recognize you. Try again or enter your app password.';
    case 'locked-out':
      return 'Touch ID is locked. Enter your app password.';
    case 'enrollment-changed':
      return 'Touch ID enrollment changed. Unlock with your password, then enable it again in Settings.';
    case 'recovery-required':
      return 'This library requires its exported recovery key.';
    case 'library-in-use':
      return 'This library is open in another Overlook instance. Close it there, then try again.';
    case 'not-enabled':
    case 'unavailable':
      return 'Touch ID is unavailable. Enter your app password.';
  }
}
