import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { ProviderDescriptor } from '../../../shared/backup/provider-descriptor.js';
import type { RestoreLibrarySummary, RestoreMissingObject, RestoreProgressContract } from '../../../shared/backup/restore-contract.js';
import { useFormats } from '../i18n/use-formats.js';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { Checkbox } from '../components/Checkbox.js';
import { Icon } from '../components/Icon.js';
import { ProgressBar } from '../components/ProgressBar.js';

import './restore.css';

export interface RestoreWorkflowProps {
  readonly context: 'onboarding' | 'settings';
  readonly onStartNew?: (() => void) | undefined;
}

type Step = 'setup' | 'choose' | 'verify' | 'confirm' | 'running' | 'complete';

const ERROR_HELP: Record<string, string> = {
  auth: 'Reconnect the provider, then try discovery again.',
  offline: 'Check your connection. The staged restore can resume when the provider is reachable.',
  'disk-space': 'Free local disk space, then resume. No active-library data was changed.',
  corrupt: 'The cloud copy failed validation. A retained generation may still be available.',
  'wrong-key': 'Use the recovery key and password exported for this library.',
  unsupported: 'Update Overlook before restoring this newer backup.',
  'destructive-authorization': 'Confirm replacement before restoring over this library.',
  cancelled: 'Restore paused. Verified staged work remains available to resume.',
  io: 'The restore could not continue. Your active library remains unchanged.',
};

const messages = defineMessages({
  openExisting: { id: 'restore.local.openExisting', defaultMessage: 'Open existing library…' },
  openingExisting: { id: 'restore.local.openingExisting', defaultMessage: 'Opening local library…' },
  notLibrary: { id: 'restore.local.error.notLibrary', defaultMessage: "That folder isn't an Overlook library." },
  notLibraryHelp: {
    id: 'restore.local.error.notLibraryHelp',
    defaultMessage: 'Choose the Overlook library folder that contains library.db.',
  },
  alreadyRegistered: { id: 'restore.local.error.alreadyRegistered', defaultMessage: 'That library is already registered.' },
  alreadyRegisteredHelp: {
    id: 'restore.local.error.alreadyRegisteredHelp',
    defaultMessage: 'Choose the registered library from the library switcher.',
  },
  openFailed: { id: 'restore.local.error.openFailed', defaultMessage: 'The existing local library could not be opened.' },
  openFailedHelp: {
    id: 'restore.local.error.openFailedHelp',
    defaultMessage: 'The local library was not changed. Choose its folder and try again.',
  },
  heroWithLocalKey: {
    id: 'restore.localKey.hero',
    defaultMessage: "Restore with this Mac's saved key, or use your separately saved recovery key. The key is never stored in the cloud.",
  },
  useLocalKey: { id: 'restore.localKey.action', defaultMessage: "Restore with this Mac's key" },
  localKeyHint: {
    id: 'restore.localKey.hint',
    defaultMessage: "This library's stored key restores its own backups — no key file needed.",
  },
  localKeyNoMatch: { id: 'restore.localKey.noMatch', defaultMessage: "No cloud library matches this Mac's stored key." },
  missingHeading: { id: 'restore.missing.heading', defaultMessage: 'Restore complete — some items were NOT FOUND' },
  missingCount: {
    id: 'restore.missing.count',
    defaultMessage: '{count, plural, one {# object was} other {# objects were}} not found or failed verification in the cloud backup',
  },
  missingHelp: {
    id: 'restore.missing.help',
    defaultMessage:
      'Unverified photos and companion files were excluded from the healed library. The next normal backup publishes this reduced catalog as the new cloud truth. The full excluded-object list is saved as restore-report.json in the library folder.',
  },
  restoredCount: {
    id: 'restore.restored.count',
    defaultMessage: '{count, plural, one {# photo restored.} other {# photos restored.}}',
  },
  localKeyPasswordLabel: { id: 'restore.localKey.passwordLabel', defaultMessage: 'App password' },
  localKeyPasswordHelp: {
    id: 'restore.localKey.passwordHelp',
    defaultMessage: "Your app lock protects this Mac's stored key. Enter the password you unlock Overlook with.",
  },
  verifyHeading: { id: 'restore.verify.heading', defaultMessage: 'Verify backup before restore' },
  verifyCounts: {
    id: 'restore.verify.counts',
    defaultMessage: '{missing} missing, {corrupt} corrupt (failed verification) — {verified} verified',
  },
  verifyHelp: {
    id: 'restore.verify.help',
    defaultMessage:
      'A single missing or corrupt object must not prevent restoring what can be verified. Review the gap and choose how to proceed. Export options stay on this screen for triage.',
  },
  exportCsv: { id: 'restore.verify.exportCsv', defaultMessage: 'Export CSV' },
  exportCorrupt: { id: 'restore.verify.exportCorrupt', defaultMessage: 'Export corrupt images' },
  continueVerified: { id: 'restore.verify.continue', defaultMessage: 'Continue with verified only' },
  trashBackup: { id: 'restore.verify.trash', defaultMessage: 'Trash backup and quit' },
  trashConfirmLabel: { id: 'restore.verify.trashConfirm', defaultMessage: 'Type Permanently Delete Backup to confirm' },
  trashConfirmPlaceholder: { id: 'restore.verify.trashPlaceholder', defaultMessage: 'Permanently Delete Backup' },
  details: { id: 'restore.error.details', defaultMessage: 'Details' },
  copyError: { id: 'restore.error.copy', defaultMessage: 'Copy error' },
});

function fileName(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path;
}

function stageLabel(stage: RestoreProgressContract['stage']): string {
  switch (stage) {
    case 'discovering':
      return 'Validating cloud backup';
    case 'downloading':
      return 'Downloading and verifying originals';
    case 'rebuilding':
      return 'Rebuilding thumbnails and catalog';
    case 'activating':
      return 'Activating restored library';
    case 'complete':
      return 'Restore complete';
  }
}

function LibraryCard({
  library,
  selected,
  onSelect,
}: {
  readonly library: RestoreLibrarySummary;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  const intl = useIntl();
  const { formatBytes, formatCount } = useFormats();
  const valid = library.validation === 'valid';
  return (
    <button
      type="button"
      className={`ovl-restore__library${selected ? ' ovl-restore__library--selected' : ''}`}
      disabled={!valid}
      aria-pressed={selected}
      onClick={onSelect}
      data-testid="restore-library-card"
    >
      <div className="ovl-restore__libraryHead">
        <span className="ovl-restore__libraryId mono-data">{library.libraryId}</span>
        <Badge tone={valid ? 'green' : library.validation === 'unsupported' ? 'amber' : 'red'}>
          {valid ? 'Validated' : library.validation.replace('-', ' ')}
        </Badge>
      </div>
      {valid ? (
        <div className="ovl-restore__meta mono-data">
          Gen {String(library.generation)} · {formatCount(library.photos ?? 0)} photos · {formatBytes(library.totalBytes ?? 0)} ·{' '}
          {formatCount(library.albums ?? 0)} albums
        </div>
      ) : (
        <div className="ovl-restore__meta">Metadata is unavailable until this backup validates.</div>
      )}
      {library.generatedAt === null ? null : (
        <div className="ovl-restore__date">
          Backed up {intl.formatDate(library.generatedAt, { dateStyle: 'medium', timeStyle: 'short' })}
        </div>
      )}
      {library.fallbackGenerations > 0 ? (
        <div className="ovl-restore__notice">{formatCount(library.fallbackGenerations)} retained fallback generation available</div>
      ) : null}
      {library.resumable ? <div className="ovl-restore__notice">Verified staged work is ready to resume</div> : null}
    </button>
  );
}

export function RestoreWorkflow({ context, onStartNew }: RestoreWorkflowProps): ReactElement {
  const intl = useIntl();
  const { formatCount } = useFormats();
  const [providers, setProviders] = useState<readonly ProviderDescriptor[]>([]);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [openingLocal, setOpeningLocal] = useState(false);
  const [keyPath, setKeyPath] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  // #754: when an app lock is configured, the main process refuses local-key
  // discovery until the app password proves fresh authority. The field only
  // appears after that refusal — an unconfigured lock never sees it.
  const [appPassword, setAppPassword] = useState('');
  const [appPasswordNeeded, setAppPasswordNeeded] = useState(false);
  const [step, setStep] = useState<Step>('setup');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [libraries, setLibraries] = useState<readonly RestoreLibrarySummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(context === 'onboarding');
  const [progress, setProgress] = useState<RestoreProgressContract | null>(null);
  const [error, setError] = useState<{ reason: string; message: string } | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [missing, setMissing] = useState<readonly RestoreMissingObject[]>([]);
  const [restoredPhotoCount, setRestoredPhotoCount] = useState<number | null>(null);
  const [verifyResult, setVerifyResult] = useState<{
    verificationId: string;
    missing: readonly RestoreMissingObject[];
    missingCount: number;
    corruptCount: number;
    verifiedCount: number;
    photos: number;
  } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [trashConfirm, setTrashConfirm] = useState('');
  const [showTrashConfirm, setShowTrashConfirm] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const descriptor = providers.find((provider) => provider.id === providerId) ?? null;
  const selected = useMemo(() => libraries.find((library) => library.libraryId === selectedId) ?? null, [libraries, selectedId]);

  useEffect(() => {
    void Promise.all([window.overlook.backup.providers(), window.overlook.settings.get()]).then(([catalog, settings]) => {
      setProviders(catalog.providers);
      const selectedProvider = catalog.providers.some((provider) => provider.id === settings.settings.providerId)
        ? settings.settings.providerId
        : catalog.defaultProviderId;
      setProviderId(selectedProvider);
    });
  }, []);

  useEffect(() => {
    if (providerId === null) return;
    void window.overlook.backup.providerStatus({ providerId }).then((status) => {
      setConnected(status.connected);
    });
  }, [providerId]);

  useEffect(() => window.overlook.restore.onProgress(setProgress), []);

  // Every result on screen belongs to exactly one discovery (#748): a
  // provider change or a return to setup invalidates the previous attempt's
  // session, library list, selection, error, and fallback notice — a stale
  // error from provider A must never render over provider B's screens.
  // Monotonic discovery generation (#748): each reset/new attempt bumps it, so a
  // still-in-flight discover() from a superseded attempt resolves into a no-op
  // instead of repainting provider A's session/libraries/error over provider B
  // (or back over the setup step). Clearing state alone can't fix this — the old
  // promise is already scheduled.
  const discoveryGenerationRef = useRef(0);

  const resetDiscovery = (): void => {
    discoveryGenerationRef.current += 1;
    setError(null);
    setSessionId(null);
    setLibraries([]);
    setSelectedId(null);
    setFallbackNotice(null);
    setMissing([]);
    setRestoredPhotoCount(null);
    setVerifyResult(null);
    setShowTrashConfirm(false);
    setTrashConfirm('');
    setActionNotice(null);
  };

  const runDiscovery = (request: Parameters<typeof window.overlook.restore.discover>[0], noMatch: string): void => {
    resetDiscovery();
    const generation = discoveryGenerationRef.current;
    setStep('choose');
    void window.overlook.restore.discover(request).then((response) => {
      // A newer reset/attempt superseded this one — drop the stale response.
      if (discoveryGenerationRef.current !== generation) return;
      if (response.error !== null) {
        if ('localKey' in request && response.error.reason === 'destructive-authorization') setAppPasswordNeeded(true);
        setError(response.error);
        setStep('setup');
        return;
      }
      setSessionId(response.sessionId);
      setLibraries(response.libraries);
      const firstValid = response.libraries.find((library) => library.validation === 'valid');
      setSelectedId(firstValid?.libraryId ?? null);
      if (firstValid === undefined) {
        const onlyWrongKey = response.libraries.length > 0 && response.libraries.every((library) => library.validation === 'wrong-key');
        setError(
          onlyWrongKey
            ? { reason: 'wrong-key', message: noMatch }
            : { reason: 'corrupt', message: 'No readable cloud library was found for this key.' },
        );
      }
    });
  };

  const discover = (): void => {
    if (providerId === null || keyPath === null || password === '') return;
    runDiscovery({ providerId, keyPath, password }, 'No cloud library matches this recovery key.');
  };

  // The open library's own keystore already holds the key its backups were
  // sealed under — restore must not demand the exported file here (#741).
  const discoverWithLocalKey = (): void => {
    if (providerId === null) return;
    runDiscovery(
      { providerId, localKey: true, ...(appPassword === '' ? {} : { password: appPassword }) },
      intl.formatMessage(messages.localKeyNoMatch),
    );
  };

  const verify = (): void => {
    if (sessionId === null || selectedId === null) return;
    setError(null);
    setVerifying(true);
    setActionNotice(null);
    setStep('verify');
    void window.overlook.restore
      .verify({ sessionId, libraryId: selectedId })
      .then((response) => {
        setVerifying(false);
        if (response.error !== null) {
          setError(response.error);
          return;
        }
        if (response.result !== null) {
          setVerifyResult({
            verificationId: response.result.verificationId,
            missing: response.result.missing,
            missingCount: response.result.missingCount,
            corruptCount: response.result.corruptCount,
            verifiedCount: response.result.verifiedCount,
            photos: response.result.photos,
          });
          if (response.result.missingCount === 0 && response.result.corruptCount === 0) setStep('confirm');
        }
      })
      .catch(() => {
        setVerifying(false);
        setError({ reason: 'io', message: 'Verification failed. Check your connection and try again.' });
      });
  };
  const run = (): void => {
    if (sessionId === null || selectedId === null || verifyResult === null || !authorized) return;
    setError(null);
    setStep('running');
    void window.overlook.restore
      .run({ sessionId, libraryId: selectedId, verificationId: verifyResult.verificationId, allowReplace: context === 'settings' })
      .then((response) => {
        if (response.error !== null) {
          setError(response.error);
          if (response.error.reason === 'cancelled') {
            setVerifyResult(null);
            setStep('choose');
          } else {
            setStep('confirm');
          }
          return;
        }
        if (response.result?.fallbackFromGeneration !== null && response.result?.fallbackFromGeneration !== undefined) {
          setFallbackNotice(
            `Generation ${String(response.result.fallbackFromGeneration)} failed validation; restored generation ${String(response.result.generation)}.`,
          );
        }
        setMissing(response.result?.missing ?? []);
        setRestoredPhotoCount(response.result?.photos ?? null);
        setStep('complete');
      });
  };

  const openExisting = (): void => {
    if (openingLocal) return;
    setOpeningLocal(true);
    setError(null);
    void window.overlook.libraries
      .add({ path: null })
      .then((outcome) => {
        if (!outcome.ok) {
          setOpeningLocal(false);
          if (outcome.reason !== 'cancelled') {
            setError({
              reason: outcome.reason,
              message:
                outcome.reason === 'not-a-library'
                  ? intl.formatMessage(messages.notLibrary)
                  : intl.formatMessage(messages.alreadyRegistered),
            });
          }
          return;
        }
        // Registration alone does not move the dataDir-bound app-lock host.
        // Use the normal switch path even though this fresh profile has no
        // open library: it selects the retained directory, swaps/initializes
        // its lock controller, and reloads into either LockScreen or Shell.
        // A successful switch destroys this renderer before its promise
        // callback runs, matching LibrarySwitcher behavior.
        void window.overlook.libraries
          .open({ id: outcome.library.id })
          .then((opened) => {
            if (!opened.ok) {
              setOpeningLocal(false);
              setError({ reason: 'local-open', message: intl.formatMessage(messages.openFailed) });
            }
          })
          .catch(() => {
            setOpeningLocal(false);
            setError({ reason: 'local-open', message: intl.formatMessage(messages.openFailed) });
          });
      })
      .catch(() => {
        setOpeningLocal(false);
        setError({ reason: 'local-open', message: intl.formatMessage(messages.openFailed) });
      });
  };

  return (
    <div className="ovl-restore" data-testid="restore-workflow">
      <div className="ovl-restore__hero">
        <Icon name="cloud-download" size={28} color="var(--accent-cyan)" />
        <div>
          <h2>Restore from cloud backup</h2>
          <p>
            {context === 'settings'
              ? intl.formatMessage(messages.heroWithLocalKey)
              : 'Choose a provider and your separately saved recovery key. The key is never stored in the cloud.'}
          </p>
        </div>
      </div>

      {step === 'setup' ? (
        <>
          <label className="ovl-restore__field">
            <span>Cloud provider</span>
            <select
              value={providerId ?? ''}
              onChange={(event) => {
                setProviderId(event.target.value);
                setConnected(false);
                resetDiscovery();
              }}
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id} disabled={!provider.available}>
                  {provider.label}
                </option>
              ))}
            </select>
          </label>
          <div className="ovl-restore__connection">
            <Badge tone={connected ? 'green' : 'neutral'}>{connected ? 'Connected' : 'Not connected'}</Badge>
            {connected ? null : (
              <Button
                variant="primary"
                disabled={providerId === null || connecting || descriptor?.available === false}
                onClick={() => {
                  if (providerId === null) return;
                  setConnecting(true);
                  setError(null);
                  void window.overlook.backup.connect({ providerId }).then((result) => {
                    setConnecting(false);
                    setConnected(result.ok);
                    if (!result.ok) setError({ reason: 'auth', message: result.reason ?? 'Connection failed.' });
                  });
                }}
              >
                {connecting ? 'Connecting…' : `Connect ${descriptor?.label ?? 'provider'}`}
              </Button>
            )}
            {descriptor?.available === false && descriptor.unavailableReason !== null ? <span>{descriptor.unavailableReason}</span> : null}
          </div>
          {context === 'settings' ? (
            <>
              <div className="ovl-restore__keyrow">
                <Button
                  variant="primary"
                  icon="key-round"
                  disabled={!connected || (appPasswordNeeded && appPassword === '')}
                  onClick={discoverWithLocalKey}
                >
                  {intl.formatMessage(messages.useLocalKey)}
                </Button>
                <span>{intl.formatMessage(messages.localKeyHint)}</span>
              </div>
              {appPasswordNeeded ? (
                <label className="ovl-restore__field">
                  <span>{intl.formatMessage(messages.localKeyPasswordLabel)}</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={appPassword}
                    maxLength={1024}
                    onChange={(event) => setAppPassword(event.target.value)}
                  />
                </label>
              ) : null}
            </>
          ) : null}
          <div className="ovl-restore__keyrow">
            <Button
              icon="key-round"
              onClick={() => {
                void window.overlook.restore.pickKey().then(({ path }) => setKeyPath(path));
              }}
            >
              Choose recovery key
            </Button>
            <span className="mono-data">{keyPath === null ? 'No key selected' : fileName(keyPath)}</span>
          </div>
          <label className="ovl-restore__field">
            <span>Recovery-key password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              maxLength={1024}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <div className="ovl-restore__actions">
            {context === 'onboarding' ? (
              <>
                <Button variant="secondary" icon="folder-open" disabled={openingLocal} onClick={openExisting}>
                  {intl.formatMessage(openingLocal ? messages.openingExisting : messages.openExisting)}
                </Button>
                <Button variant="ghost" onClick={onStartNew}>
                  Start a new library
                </Button>
              </>
            ) : null}
            <Button variant="primary" disabled={!connected || keyPath === null || password === ''} onClick={discover}>
              Discover backups
            </Button>
          </div>
        </>
      ) : step === 'choose' ? (
        <>
          <div className="ovl-restore__sectionTitle">Available libraries</div>
          <div className="ovl-restore__libraries">
            {libraries.length === 0 && error === null ? <div className="ovl-restore__empty">Validating cloud libraries…</div> : null}
            {libraries.map((library) => (
              <LibraryCard
                key={library.libraryId}
                library={library}
                selected={library.libraryId === selectedId}
                onSelect={() => setSelectedId(library.libraryId)}
              />
            ))}
          </div>
          <div className="ovl-restore__actions">
            <Button
              variant="ghost"
              onClick={() => {
                resetDiscovery();
                setStep('setup');
              }}
            >
              Back
            </Button>
            <Button variant="primary" disabled={selectedId === null} onClick={verify}>
              Verify backup
            </Button>
          </div>
        </>
      ) : step === 'verify' ? (
        <>
          <div className="ovl-restore__sectionTitle">{intl.formatMessage(messages.verifyHeading)}</div>
          {verifying ? (
            <div className="ovl-restore__empty">Scanning cloud backup — classifying verified vs missing vs corrupt…</div>
          ) : verifyResult === null ? (
            <div className="ovl-restore__empty">Preparing verification…</div>
          ) : (
            <>
              <div className="ovl-restore__warnings" data-testid="restore-verify">
                <strong>
                  {intl.formatMessage(messages.verifyCounts, {
                    missing: verifyResult.missingCount,
                    corrupt: verifyResult.corruptCount,
                    verified: verifyResult.verifiedCount,
                  })}
                </strong>
                <span>{intl.formatMessage(messages.verifyHelp)}</span>
                {verifyResult.missing.length === 0 ? null : (
                  <ul className="mono-data ovl-restore__verifyList">
                    {verifyResult.missing.map((o) => (
                      <li key={o.path}>
                        {o.path} — {o.kind} — {o.reason}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="ovl-restore__actions ovl-restore__verifyActions">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      if (sessionId === null || selectedId === null) return;
                      setActionNotice(null);
                      void window.overlook.restore
                        .exportCsv({ sessionId, libraryId: selectedId, verificationId: verifyResult.verificationId })
                        .then((result) => {
                          setActionNotice(
                            result.error ??
                              (result.exported ? `CSV exported to ${result.path ?? 'the selected file'}.` : 'CSV export cancelled.'),
                          );
                        });
                    }}
                  >
                    {intl.formatMessage(messages.exportCsv)}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      if (sessionId === null || selectedId === null) return;
                      setActionNotice(null);
                      void window.overlook.restore
                        .exportCorrupt({ sessionId, libraryId: selectedId, verificationId: verifyResult.verificationId })
                        .then((result) => {
                          setActionNotice(
                            result.error ??
                              (result.exported
                                ? `${formatCount(result.count)} corrupt images exported.`
                                : 'Corrupt-image export cancelled.'),
                          );
                        });
                    }}
                  >
                    {intl.formatMessage(messages.exportCorrupt)}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => {
                      // Continue with verified only — heal and proceed to confirm with verified count
                      setStep('confirm');
                    }}
                  >
                    {intl.formatMessage(messages.continueVerified)} ({formatCount(verifyResult.verifiedCount)} photos)
                  </Button>
                  <Button variant="danger" onClick={() => setShowTrashConfirm(true)}>
                    {intl.formatMessage(messages.trashBackup)}
                  </Button>
                </div>
                {actionNotice === null ? null : (
                  <div className="ovl-restore__notice" role="status">
                    {actionNotice}
                  </div>
                )}
                {showTrashConfirm ? (
                  <div className="ovl-restore__warnings ovl-restore__trashWarning">
                    <strong>
                      Trash backup and quit — this moves the scoped cloud backup to the provider's Trash or Recently Deleted area. Recovery
                      remains subject to the provider's retention window.
                    </strong>
                    <label className="ovl-restore__field">
                      <span>{intl.formatMessage(messages.trashConfirmLabel)}</span>
                      <input
                        value={trashConfirm}
                        onChange={(e) => setTrashConfirm(e.target.value)}
                        placeholder={intl.formatMessage(messages.trashConfirmPlaceholder)}
                      />
                    </label>
                    <div className="ovl-restore__actions">
                      <Button variant="ghost" onClick={() => setShowTrashConfirm(false)}>
                        Cancel
                      </Button>
                      <Button
                        variant="danger"
                        disabled={trashConfirm !== 'Permanently Delete Backup'}
                        onClick={() => {
                          if (sessionId === null || selectedId === null) return;
                          void window.overlook.restore
                            .trash({
                              sessionId,
                              libraryId: selectedId,
                              verificationId: verifyResult.verificationId,
                              confirmation: trashConfirm,
                            })
                            .then((res) => {
                              if (res.trashed) {
                                window.close();
                                return;
                              }
                              setError(res.error ?? { reason: 'io', message: 'The backup was not fully moved to Trash.' });
                            });
                        }}
                      >
                        Confirm trash
                      </Button>
                    </div>
                  </div>
                ) : null}
                <Button variant="ghost" onClick={() => setStep('choose')}>
                  Back
                </Button>
              </div>
            </>
          )}
        </>
      ) : step === 'confirm' && selected !== null ? (
        <>
          <div className="ovl-restore__warnings">
            <strong>{context === 'settings' ? 'This replaces the active library.' : 'Ready to restore this library.'}</strong>
            <ul>
              <li>Disk space is checked before any originals download.</li>
              <li>Downloads are staged, verified, and resumable after cancellation.</li>
              <li>The current library remains active unless the complete staged restore validates.</li>
              <li>Activation uses rollback-safe replacement, then Overlook relaunches.</li>
            </ul>
            {verifyResult !== null ? (
              <span>
                Verified {formatCount(verifyResult.verifiedCount)} of {formatCount(verifyResult.photos)} photos will be restored;{' '}
                {formatCount(verifyResult.missingCount + verifyResult.corruptCount)} unverified objects will be excluded and recorded in the
                restore report.
              </span>
            ) : null}
          </div>
          {context === 'settings' ? (
            <Checkbox
              checked={authorized}
              label="I understand that the active local library will be replaced after validation."
              onChange={setAuthorized}
            />
          ) : null}
          <div className="ovl-restore__actions">
            <Button
              variant="ghost"
              onClick={() =>
                setStep(verifyResult !== null && verifyResult.missingCount + verifyResult.corruptCount > 0 ? 'verify' : 'choose')
              }
            >
              Back
            </Button>
            <Button variant={context === 'settings' ? 'danger' : 'primary'} disabled={!authorized} onClick={run}>
              Restore {formatCount(verifyResult?.verifiedCount ?? selected.photos ?? 0)} photos
            </Button>
          </div>
        </>
      ) : step === 'running' ? (
        <div className="ovl-restore__running" aria-live="polite">
          <div className="ovl-restore__sectionTitle">{progress === null ? 'Preparing restore' : stageLabel(progress.stage)}</div>
          <ProgressBar
            value={progress?.done ?? 0}
            max={Math.max(progress?.total ?? 1, 1)}
            label={progress === null ? 'Starting' : stageLabel(progress.stage)}
            {...(progress === null ? {} : { detail: `${String(progress.done)} / ${String(progress.total)}` })}
          />
          <Button
            variant="secondary"
            disabled={progress?.stage === 'activating' || progress?.stage === 'complete'}
            onClick={() => void window.overlook.restore.cancel({})}
          >
            Cancel and keep staged progress
          </Button>
        </div>
      ) : (
        <div className="ovl-restore__complete" aria-live="polite">
          <Icon name="circle-check" size={28} color={missing.length === 0 ? 'var(--accent-green)' : 'var(--accent-amber)'} />
          <strong>{missing.length === 0 ? 'Restore complete' : intl.formatMessage(messages.missingHeading)}</strong>
          <span className="ovl-restore__completeSummary">
            {restoredPhotoCount === null ? null : <span>{intl.formatMessage(messages.restoredCount, { count: restoredPhotoCount })}</span>}
            <span>{fallbackNotice ?? 'Overlook is relaunching with the restored library.'}</span>
          </span>
          {missing.length === 0 ? null : (
            <div className="ovl-restore__warnings ovl-restore__missing" data-testid="restore-missing">
              <strong>{intl.formatMessage(messages.missingCount, { count: missing.length })}</strong>
              <span>{intl.formatMessage(messages.missingHelp)}</span>
              <ul className="mono-data">
                {missing.map((object) => (
                  <li key={object.path}>{object.path}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {error === null ? null : (
        <div className="ovl-restore__error" role="alert">
          <strong>{error.message}</strong>
          <span>
            {error.reason === 'not-a-library'
              ? intl.formatMessage(messages.notLibraryHelp)
              : error.reason === 'already-registered'
                ? intl.formatMessage(messages.alreadyRegisteredHelp)
                : error.reason === 'local-open'
                  ? intl.formatMessage(messages.openFailedHelp)
                  : error.reason === 'destructive-authorization' && appPasswordNeeded && step === 'setup'
                    ? intl.formatMessage(messages.localKeyPasswordHelp)
                    : (ERROR_HELP[error.reason] ?? ERROR_HELP['io'])}
          </span>
          <details className="ovl-restore__errorDetails">
            <summary>{intl.formatMessage(messages.details)}</summary>
            <pre className="mono-data ovl-restore__errorText">{`reason: ${error.reason}\nmessage: ${error.message}`}</pre>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void navigator.clipboard.writeText(`reason: ${error.reason}\nmessage: ${error.message}`)}
            >
              {intl.formatMessage(messages.copyError)}
            </Button>
          </details>
        </div>
      )}
    </div>
  );
}
