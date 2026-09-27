import { useEffect, useState, type ReactElement } from 'react';

import { strengthOf } from '../../../shared/crypto/password-strength.js';
import { useFormats } from '../i18n/use-formats.js';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { PasswordField } from '../components/PasswordField';
import { ProgressBar } from '../components/ProgressBar';

import './protected.css';

export type ProtectedAlbumCeremonyMode = 'protect' | 'unlock' | 'change' | 'remove' | 'recover';

interface WorkflowProgress {
  readonly operation: 'protect' | 'unprotect';
  readonly stage: 'preparing' | 'copying' | 'verifying' | 'committing' | 'purging' | 'complete';
  readonly done: number;
  readonly total: number;
}

export interface ProtectedAlbumCeremonyProps {
  readonly mode: ProtectedAlbumCeremonyMode;
  readonly albumId: string;
  readonly albumName?: string | undefined;
  readonly onClose: () => void;
  readonly onComplete: (message: string) => void;
}

const STAGES = ['preparing', 'copying', 'verifying', 'committing', 'purging', 'complete'] as const;

function PasswordMeter({ password }: { readonly password: string }): ReactElement {
  const strength = strengthOf(password);
  return (
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
  );
}

function titleFor(mode: ProtectedAlbumCeremonyMode, albumName: string | undefined): string {
  if (mode === 'protect') return `Protect “${albumName ?? 'album'}”`;
  if (mode === 'unlock') return 'Unlock protected album';
  if (mode === 'change') return 'Change protected album password';
  if (mode === 'remove') return 'Remove album protection';
  return 'Recover protected album';
}

function resultError(reason: string | null): string {
  if (reason === 'wrong-password') return 'The current album password is incorrect.';
  if (reason === 'wrong-recovery-key') return 'That recovery file or its password does not match this protected album.';
  if (reason === 'empty') return 'Add at least one local photo before protecting this album.';
  if (reason === 'conflict') return 'Another migration is active, or the original album destination already exists.';
  if (reason === 'cancelled') return 'Cancelled at a safe boundary. The verified source is unchanged.';
  if (reason === 'not-found') return 'The album is no longer available.';
  return 'The operation could not complete safely. The last verified copy was kept.';
}

export function ProtectedAlbumCeremony({ mode, albumId, albumName, onClose, onComplete }: ProtectedAlbumCeremonyProps): ReactElement {
  const { formatCount } = useFormats();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [recoveryPath, setRecoveryPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<WorkflowProgress | null>(null);
  const strength = strengthOf(next);
  const needsNext = mode === 'protect' || mode === 'change' || mode === 'recover';
  const needsCurrent = mode === 'unlock' || mode === 'change' || mode === 'remove' || mode === 'recover';
  const canSubmit =
    !busy &&
    (!needsCurrent || current.length > 0) &&
    (!needsNext || (next.length >= 8 && next === confirm && strength.score >= 3)) &&
    (mode !== 'recover' || recoveryPath !== null);

  useEffect(() => window.overlook.protectedAlbums.onProgress(setProgress), []);

  const submit = (): void => {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    setProgress(null);
    const operation = async (): Promise<{ readonly ok: boolean; readonly message: string; readonly reason: string | null }> => {
      if (mode === 'protect') {
        const result = await window.overlook.protectedAlbums.protect({ albumId, password: next });
        return { ok: result.ok, reason: result.reason, message: 'Album protected and relocked' };
      }
      if (mode === 'unlock') {
        const result = await window.overlook.protectedAlbums.unlock({ albumId, password: current });
        return {
          ok: result.ok,
          reason: result.ok ? null : 'wrong-password',
          message:
            result.outcome === 'protection-completed'
              ? 'Interrupted protection completed safely'
              : result.outcome === 'removal-completed'
                ? 'Interrupted removal completed safely'
                : 'Protected album unlocked for this session',
        };
      }
      if (mode === 'change') {
        const result = await window.overlook.protectedAlbums.changePassword({
          albumId,
          currentPassword: current,
          nextPassword: next,
        });
        return { ok: result.changed, reason: result.changed ? null : 'wrong-password', message: 'Password changed · album relocked' };
      }
      if (mode === 'remove') {
        const result = await window.overlook.protectedAlbums.unprotect({ albumId, password: current });
        return { ok: result.ok, reason: result.reason, message: 'Protection removed safely' };
      }
      const result = await window.overlook.protectedAlbums.recover({
        albumId,
        path: recoveryPath!,
        recoveryPassword: current,
        nextPassword: next,
      });
      return { ok: result.recovered, reason: result.reason, message: 'Password recovered · album relocked' };
    };
    void operation()
      .then((result) => {
        if (!result.ok) {
          setError(resultError(result.reason));
          return;
        }
        setCurrent('');
        setNext('');
        setConfirm('');
        onComplete(result.message);
      })
      .catch(() => setError(resultError(null)))
      .finally(() => setBusy(false));
  };

  const mismatch = confirm.length > 0 && next !== confirm;
  const progressIndex = progress === null ? 0 : STAGES.indexOf(progress.stage) + 1;
  const canCancel = progress !== null && ['preparing', 'copying', 'verifying'].includes(progress.stage);
  const action =
    mode === 'protect'
      ? 'Protect album'
      : mode === 'unlock'
        ? 'Unlock'
        : mode === 'change'
          ? 'Change password'
          : mode === 'remove'
            ? 'Remove protection'
            : 'Recover';

  return (
    <Dialog
      open
      title={titleFor(mode, albumName)}
      icon={mode === 'recover' ? 'file-key' : 'lock'}
      width={460}
      {...(busy ? {} : { onClose })}
      footer={
        <>
          {busy && canCancel ? (
            <Button variant="ghost" onClick={() => void window.overlook.protectedAlbums.cancelWorkflow()}>
              Cancel safely
            </Button>
          ) : (
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
          )}
          <Button variant={mode === 'remove' ? 'danger' : 'primary'} icon="lock" disabled={!canSubmit} onClick={submit}>
            {busy ? 'Working…' : action}
          </Button>
        </>
      }
    >
      <form
        className="ovl-protected-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="ovl-keynote ovl-keynote--amber">
          <Icon name="shield-check" size={15} color="var(--accent-amber)" />
          <div className="ovl-keynote__body">
            {mode === 'protect'
              ? 'This album gets an independent password. Its name, counts, metadata, and photos disappear from every ordinary library surface.'
              : mode === 'remove'
                ? 'Overlook verifies an ordinary encrypted copy before retiring protected custody. Cancellation stops only before commit.'
                : mode === 'recover'
                  ? 'Use the recovery file exported for this library and its separate password. Recovery sets a new album password and does not unlock it.'
                  : 'Credential changes revoke every current album session. The album must be unlocked again with its new password.'}
          </div>
        </div>
        {mode === 'recover' ? (
          <div className="ovl-protected-file">
            <div>
              <div className="ovl-key__label mono-data">Recovery file</div>
              <div className={`ovl-protected-file__name ${recoveryPath === null ? 'prose-note' : 'mono-data'}`}>
                {recoveryPath === null ? 'No file selected' : (recoveryPath.split(/[\\/]/).at(-1) ?? 'Recovery file')}
              </div>
            </div>
            <Button
              variant="secondary"
              icon="folder-open"
              disabled={busy}
              onClick={() => {
                void window.overlook.protectedAlbums.pickRecovery().then(({ path }) => setRecoveryPath(path));
              }}
            >
              Choose…
            </Button>
          </div>
        ) : null}
        {needsCurrent ? (
          <label>
            <div className="ovl-key__label mono-data">{mode === 'recover' ? 'Recovery file password' : 'Current album password'}</div>
            <PasswordField
              value={current}
              onChange={setCurrent}
              label={mode === 'recover' ? 'Recovery file password' : 'Current album password'}
              name={mode === 'recover' ? 'protected-recovery-password' : 'protected-album-password'}
              autoComplete="current-password"
              autoFocus={mode !== 'recover'}
            />
          </label>
        ) : null}
        {needsNext ? (
          <>
            <label>
              <div className="ovl-key__label mono-data">New album password</div>
              <PasswordField
                value={next}
                onChange={setNext}
                label="New album password"
                name="new-protected-album-password"
                autoComplete="new-password"
                autoFocus={mode === 'protect'}
              />
              <PasswordMeter password={next} />
            </label>
            <label>
              <div className="ovl-key__label mono-data">Confirm password</div>
              <PasswordField
                value={confirm}
                onChange={setConfirm}
                label="Confirm password"
                name="confirm-protected-album-password"
                autoComplete="new-password"
              />
              {mismatch ? (
                <div className="ovl-key__mismatch">
                  <Icon name="triangle-alert" size={13} /> Passwords do not match
                </div>
              ) : null}
            </label>
          </>
        ) : null}
        {busy && progress !== null ? (
          <div className="ovl-protected-progress" role="status" aria-live="polite">
            <ProgressBar
              label={`${progress.operation === 'protect' ? 'Protecting' : 'Removing protection'} · ${progress.stage}`}
              detail={`${formatCount(progress.done)} / ${formatCount(progress.total)}`}
              value={progressIndex}
              max={STAGES.length}
              tone={progress.stage === 'complete' ? 'green' : 'amber'}
            />
            <div className="prose-note">
              {canCancel ? 'Cancellation is available before commit.' : 'Commit reached — finishing verified cleanup.'}
            </div>
          </div>
        ) : null}
        <div className="ovl-key__mismatch" role="status" aria-live="polite">
          {error}
        </div>
      </form>
    </Dialog>
  );
}
