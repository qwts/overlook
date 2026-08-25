import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { FormattedMessage, defineMessages, useIntl } from 'react-intl';

import './move-library.css';
import { useFormats } from '../i18n/use-formats.js';
import type { LibraryDescriptor } from '../../../shared/library/registry.js';
import type { RelocationFailureReason } from '../../../shared/library/relocation.js';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { ProgressBar } from '../components/ProgressBar';

// Move library wizard (#483, ADR-0022): REVIEW → PROGRESS → RESULTS over the
// library-relocation IPC. Batch = N sequential single moves (ADR-0022 §7),
// inactive libraries first and the open library last — moving the open
// library reloads this window at the end, so everything that can finish and
// report must finish first. Cancel maps to the engine's pre-commit rollback
// only: once a library's progress reaches "committing" the move has happened,
// and the affordance changes rather than pretending (handoff contract).

type WizardPhase = 'review' | 'progress' | 'results';

type RowStatus = 'pending' | 'active' | 'moved' | 'cleanup-pending' | 'failed' | 'skipped';

interface Row {
  readonly lib: LibraryDescriptor;
  readonly status: RowStatus;
  readonly destPath: string | null;
  readonly reason?: RelocationFailureReason;
  readonly detail?: string;
  readonly bytes?: number;
  readonly items?: number;
  readonly mode?: 'copy' | 'rename';
}

interface DestinationGrant {
  readonly root: string;
  readonly authorization: string;
}

// Every failure reason renders as decided copy: refusals are designed
// outcomes (ADR-0022 §5), and a mistranslated or missing sentence here is a
// data-loss bug with a friendly face (ADR-0020's ruling).
const reasonMessages = defineMessages({
  'source-unreadable': {
    id: 'libmove.reason.sourceUnreadable',
    defaultMessage: 'The library could not be read from its current location.',
  },
  'destination-not-writable': { id: 'libmove.reason.destinationNotWritable', defaultMessage: 'The destination is not writable.' },
  'destination-not-empty': {
    id: 'libmove.reason.destinationNotEmpty',
    defaultMessage: 'The destination folder is not empty — Overlook never overwrites or merges.',
  },
  'destination-registered': {
    id: 'libmove.reason.destinationRegistered',
    defaultMessage: 'The destination already belongs to a registered library.',
  },
  'invalid-destination': { id: 'libmove.reason.invalidDestination', defaultMessage: 'That destination is not usable for a library.' },
  'insufficient-space': { id: 'libmove.reason.insufficientSpace', defaultMessage: 'Not enough free space on the destination.' },
  'unsupported-filesystem': {
    id: 'libmove.reason.unsupportedFilesystem',
    defaultMessage: 'The destination filesystem cannot hold a library safely.',
  },
  locked: { id: 'libmove.reason.locked', defaultMessage: 'The library is open in another Overlook instance.' },
  'verification-failed': {
    id: 'libmove.reason.verificationFailed',
    defaultMessage: 'The copy failed verification — the original was not touched.',
  },
  'journal-corrupt': { id: 'libmove.reason.journalCorrupt', defaultMessage: 'The move journal is damaged; nothing was changed.' },
  cancelled: { id: 'libmove.reason.cancelled', defaultMessage: 'Cancelled — the original library is untouched.' },
  'io-error': { id: 'libmove.reason.ioError', defaultMessage: 'A disk error interrupted the move — the original library is untouched.' },
  'move-in-progress': { id: 'libmove.reason.moveInProgress', defaultMessage: 'Another move is already running.' },
  'app-locked': { id: 'libmove.reason.appLocked', defaultMessage: 'Unlock Overlook before moving the open library.' },
  'provider-busy': { id: 'libmove.reason.providerBusy', defaultMessage: 'Finish or wait for the current backup or restore first.' },
  'authorization-denied': {
    id: 'libmove.reason.authorizationDenied',
    defaultMessage: 'The destination authorization expired. Choose the destination again.',
  },
});

const phaseMessages = defineMessages({
  preflight: { id: 'libmove.phase.preflight', defaultMessage: 'Checking…' },
  copying: { id: 'libmove.phase.copying', defaultMessage: 'Copying' },
  verifying: { id: 'libmove.phase.verifying', defaultMessage: 'Verifying' },
  committing: { id: 'libmove.phase.committing', defaultMessage: 'Finishing' },
  cleaning: { id: 'libmove.phase.cleaning', defaultMessage: 'Removing original' },
});

const badgeMessages = defineMessages({
  moved: { id: 'libmove.badge.moved', defaultMessage: 'Moved' },
  cleanupPending: { id: 'libmove.badge.cleanupPending', defaultMessage: 'Moved — cleanup pending' },
  failed: { id: 'libmove.badge.failed', defaultMessage: 'Failed' },
  skipped: { id: 'libmove.badge.skipped', defaultMessage: 'Skipped' },
  active: { id: 'libmove.badge.active', defaultMessage: 'Moving…' },
  waiting: { id: 'libmove.badge.waiting', defaultMessage: 'Waiting' },
});

const messages = defineMessages({
  titleOne: { id: 'libmove.title.one', defaultMessage: 'Move library' },
  titleMany: { id: 'libmove.title.many', defaultMessage: 'Move {count} libraries' },
  cancel: { id: 'libmove.review.cancel', defaultMessage: 'Cancel' },
  startOne: { id: 'libmove.review.start.one', defaultMessage: 'Move library…' },
  startMany: { id: 'libmove.review.start.many', defaultMessage: 'Move {count} libraries…' },
  openNow: { id: 'libmove.review.openNow', defaultMessage: 'Open now' },
  destination: { id: 'libmove.review.destination', defaultMessage: 'Destination' },
  destinationPlaceholder: { id: 'libmove.review.destinationPlaceholder', defaultMessage: 'Choose a destination folder…' },
  choose: { id: 'libmove.review.choose', defaultMessage: 'Choose…' },
  assurance: {
    id: 'libmove.review.assurance',
    defaultMessage:
      'The library ID, keys, albums, and backup links move unchanged. The original stays in place until every byte of the copy is verified.',
  },
  openNote: {
    id: 'libmove.review.openNote',
    defaultMessage: 'The open library moves last: Overlook closes it, moves it, and reopens it from the new location.',
  },
  backupNote: {
    id: 'libmove.review.backupNote',
    defaultMessage: 'A current cloud backup is extra safety, but never required — the move keeps one verified copy at all times.',
  },
  progressTitle: { id: 'libmove.progress.title', defaultMessage: 'Moving libraries' },
  counter: { id: 'libmove.progress.counter', defaultMessage: 'Library {n} of {total}' },
  progressLabel: { id: 'libmove.progress.label', defaultMessage: '{phase} {name}' },
  cancelRollback: { id: 'libmove.progress.cancelRollback', defaultMessage: 'Cancel & roll back' },
  finishing: { id: 'libmove.progress.finishing', defaultMessage: 'Finishing — this move can no longer roll back' },
  resultsTitle: { id: 'libmove.results.title', defaultMessage: 'Move complete' },
  retryFailed: { id: 'libmove.results.retryFailed', defaultMessage: 'Retry failed' },
  done: { id: 'libmove.results.done', defaultMessage: 'Done' },
  resultDetail: { id: 'libmove.results.detail', defaultMessage: '{items} items · {bytes} bytes · {method} · library ID {id}… unchanged' },
  methodInstant: { id: 'libmove.results.methodInstant', defaultMessage: 'Instant move' },
  methodCopy: { id: 'libmove.results.methodCopy', defaultMessage: 'Copy & verify' },
  cleanupCopy: {
    id: 'libmove.results.cleanupCopy',
    defaultMessage:
      'Both copies are verified. The move is complete; the original could not be removed yet — nothing will be deleted without you.',
  },
  finishCleanup: { id: 'libmove.results.finishCleanup', defaultMessage: 'Finish cleanup' },
  didNotReport: { id: 'libmove.error.didNotReport', defaultMessage: 'The move did not report back.' },
  destPreview: { id: 'libmove.review.destPreview', defaultMessage: '→ {path}' },
  pathArrow: { id: 'libmove.pathArrow', defaultMessage: '{from} → {to}' },
  spaceLabel: { id: 'libmove.review.spaceLabel', defaultMessage: 'Destination space' },
  spaceDetail: { id: 'libmove.review.spaceDetail', defaultMessage: '{needed} needed · {free} free' },
  networkWarning: {
    id: 'libmove.review.networkWarning',
    defaultMessage:
      'The destination is a network volume. Overlook cannot verify locks across machines and database safety is not guaranteed there.',
  },
  collisionNote: {
    id: 'libmove.review.collisionNote',
    defaultMessage: 'A folder with this name already exists — the move will use a numbered name.',
  },
  probing: { id: 'libmove.review.probing', defaultMessage: 'Checking destination…' },
});

/** Windows reserves device names (CON, PRN, AUX, NUL, COM1–9, LPT1–9) that
 * are invalid folder names even on shares mounted from other platforms. */
const RESERVED_FOLDER_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

/** A display name is arbitrary user text (1–120 chars); the destination
 * folder must be a valid name on every platform the disk might visit.
 * Unsafe characters collapse to '-'; a name that is empty or reserved after
 * sanitizing falls back to the source folder's basename (app-managed sources
 * are ULIDs) and finally the library id. */
function folderNameFor(lib: LibraryDescriptor): string {
  const named = lib.name
    .trim()
    // eslint-disable-next-line no-control-regex -- control chars are invalid in Windows filenames
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, '-')
    .replace(/[. ]+$/u, '');
  if (named !== '' && !RESERVED_FOLDER_NAMES.test(named)) return named;
  return lib.path.split(/[\\/]/u).filter(Boolean).pop() ?? lib.id;
}

/** Destination = chosen root + one collision-safe folder per library
 * (handoff / ADR-0022 §7), named after the library's DISPLAY name — an
 * app-managed source folder is a ULID, which nobody should find on their
 * external disk. The engine is the collision arbiter — it refuses occupied
 * paths — so suffixing retries are attempted in order. */
function destFor(lib: LibraryDescriptor, root: string, attempt: number): string {
  const base = folderNameFor(lib);
  return `${root}/${attempt === 1 ? base : `${base} ${String(attempt)}`}`;
}

type Probe = Awaited<ReturnType<typeof window.overlook.libraries.probeMove>>;

/** A probe outcome that must stop the move: collisions are informational
 * (the move retries numbered names); every refusal blocks Start, and so does
 * an ok probe that found the library locked by another instance — the
 * switcher list can be stale, the probe is live. */
function probeBlocks(probe: Probe | undefined): boolean {
  if (probe === undefined) return false;
  if (probe.ok) return probe.lockedBy !== null;
  return probe.reason !== 'destination-not-empty';
}

export interface MoveLibraryDialogProps {
  readonly libraries: readonly LibraryDescriptor[];
  readonly onClose: () => void;
}

export function MoveLibraryDialog({ libraries, onClose }: MoveLibraryDialogProps): ReactElement {
  const intl = useIntl();
  const { formatBytes, formatCount } = useFormats();
  // Open library moves LAST: its reactivation reloads this window.
  const ordered = [...libraries].sort((a, b) => Number(a.open) - Number(b.open));
  const [phase, setPhase] = useState<WizardPhase>('review');
  const [destination, setDestination] = useState<DestinationGrant | null>(null);
  const [destinationAuthorizationDenied, setDestinationAuthorizationDenied] = useState(false);
  const root = destination?.root ?? null;
  const [rows, setRows] = useState<readonly Row[]>(ordered.map((lib) => ({ lib, status: 'pending', destPath: null })));
  const [activeIndex, setActiveIndex] = useState(-1);
  const [progress, setProgress] = useState<{
    phase: string;
    copiedItems: number;
    totalItems: number;
    copiedBytes: number;
    totalBytes: number;
  } | null>(null);
  const [committed, setCommitted] = useState(false);
  const [probes, setProbes] = useState<ReadonlyMap<string, Probe>>(new Map());
  const stopRef = useRef(false);
  const includesOpen = ordered.some((lib) => lib.open);

  useEffect(() => {
    return window.overlook.libraries.onMoveProgress((payload) => {
      setProgress(payload);
      if (payload.phase === 'committing' || payload.phase === 'cleaning') setCommitted(true);
    });
  }, []);

  useEffect(() => {
    if (destination === null) return;
    return () => {
      void window.overlook.libraries.revokeMoveDestination({ authorization: destination.authorization });
    };
  }, [destination]);

  // Review-step dry run (#483/ADR-0022 §5): resolve the method chip, space
  // requirement, and network warning per library BEFORE anything moves. A
  // 'destination-not-empty' probe is informational — the move itself retries
  // collision-safe numbered names; every other refusal blocks Start honestly.
  useEffect(() => {
    if (destination === null) return;
    const { root: selectedRoot, authorization } = destination;
    let stale = false;
    for (const lib of ordered) {
      void window.overlook.libraries
        .probeMove({ id: lib.id, destPath: destFor(lib, selectedRoot, 1), authorization })
        .then((probe) => {
          if (!probe.ok && probe.reason === 'authorization-denied') {
            if (!stale) {
              setDestinationAuthorizationDenied(true);
              setDestination(null);
            }
            return;
          }
          // Keyed by root+library, so a destination change never needs a
          // reset — lookups for the new root simply miss until it lands.
          if (!stale) setProbes((previous) => new Map(previous).set(`${selectedRoot}\u0000${lib.id}`, probe));
        })
        .catch(() => undefined);
    }
    return () => {
      stale = true;
    };
    // ordered is derived from a stable prop; root is the only real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ordered identity churns per render
  }, [root, destination?.authorization]);

  const chooseRoot = (): void => {
    void window.overlook.libraries.pickMoveDestination().then(({ path, authorization }) => {
      if (path !== null && authorization !== null) {
        setDestinationAuthorizationDenied(false);
        setDestination({ root: path, authorization });
      }
    });
  };

  const closeDialog = (): void => {
    setDestination(null);
    onClose();
  };

  const runBatch = async (targets: readonly number[]): Promise<void> => {
    if (destination === null) return;
    const { root: selectedRoot, authorization } = destination;
    let needsRetry = false;
    let authorizationDenied = false;
    for (const index of targets) {
      if (stopRef.current) {
        needsRetry = true;
        setRows((previous) => previous.map((row, at) => (at === index && row.status === 'pending' ? { ...row, status: 'skipped' } : row)));
        continue;
      }
      setActiveIndex(index);
      setCommitted(false);
      setProgress(null);
      setRows((previous) => previous.map((row, at) => (at === index ? { ...row, status: 'active' } : row)));
      const lib = ordered[index];
      if (lib === undefined) continue;

      let outcome: Awaited<ReturnType<typeof window.overlook.libraries.move>> | null = null;
      let destPath = destFor(lib, selectedRoot, 1);
      // The engine refuses occupied paths; collision-safe naming retries
      // with a numbered suffix and gives up honestly after a few.
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        destPath = destFor(lib, selectedRoot, attempt);
        outcome = await window.overlook.libraries.move({ id: lib.id, destPath, authorization }).catch(() => null);
        if (outcome === null || outcome.ok || outcome.reason !== 'destination-not-empty') break;
      }

      setRows((previous) =>
        previous.map((row, at) => {
          if (at !== index) return row;
          if (outcome === null) {
            // The open library's successful move reloads this window before
            // the response lands — a rejection here on the LAST row of an
            // open-library batch is that reload racing us, not a failure.
            return { ...row, status: 'failed', reason: 'io-error', detail: intl.formatMessage(messages.didNotReport) };
          }
          if (outcome.ok) {
            return {
              ...row,
              status: outcome.outcome === 'moved' ? 'moved' : 'cleanup-pending',
              destPath: outcome.destPath,
              bytes: outcome.bytes,
              items: outcome.items,
              mode: outcome.mode,
            };
          }
          return {
            ...row,
            status: outcome.reason === 'cancelled' ? 'skipped' : 'failed',
            reason: outcome.reason,
            detail: outcome.detail,
            destPath,
          };
        }),
      );
      if (outcome !== null && !outcome.ok && outcome.reason === 'authorization-denied') {
        authorizationDenied = true;
        break;
      }
      if (outcome === null || !outcome.ok) needsRetry = true;
      if (outcome !== null && !outcome.ok && outcome.reason === 'cancelled') stopRef.current = true;
    }
    setActiveIndex(-1);
    if (authorizationDenied) {
      setDestinationAuthorizationDenied(true);
      setDestination(null);
      setPhase('review');
      return;
    }
    setPhase('results');
    if (!needsRetry) setDestination(null);
  };

  const start = (): void => {
    stopRef.current = false;
    setPhase('progress');
    void runBatch(rows.map((_, index) => index).filter((index) => rows[index]?.status !== 'moved'));
  };

  const retryFailed = (): void => {
    const failed = rows
      .map((row, index) => (row.status === 'failed' || row.status === 'skipped' ? index : -1))
      .filter((index) => index >= 0);
    setRows((previous) =>
      previous.map((row) => {
        if (row.status !== 'failed' && row.status !== 'skipped') return row;
        const { reason: _reason, detail: _detail, ...rest } = row;
        return { ...rest, status: 'pending' as const };
      }),
    );
    stopRef.current = false;
    setPhase('progress');
    void runBatch(failed);
  };

  const cancelCurrent = (): void => {
    const current = activeIndex >= 0 ? ordered[activeIndex] : undefined;
    if (current === undefined) return;
    stopRef.current = true;
    void window.overlook.libraries.cancelMove({ id: current.id });
  };

  const finishCleanup = (row: Row): void => {
    void window.overlook.libraries.finishMoveCleanup({ id: row.lib.id }).then(() => {
      setRows((previous) => previous.map((entry) => (entry.lib.id === row.lib.id ? { ...entry, status: 'moved' } : entry)));
    });
  };

  if (phase === 'review') {
    const many = ordered.length > 1;
    const collected = ordered.map((lib) => (root === null ? undefined : probes.get(`${root}\u0000${lib.id}`)));
    const anyBlocked = collected.some((probe) => probeBlocks(probe));
    // Start waits for every probe: on a slow volume the walk takes a moment,
    // and enabling early would let a quick click outrun the preflight.
    const anyPending = collected.some((probe) => probe === undefined);
    const copyProbes = collected.filter((probe): probe is Probe & { ok: true } => probe?.ok === true && probe.mode === 'copy');
    const requiredBytes = copyProbes.reduce((sum, probe) => sum + probe.requiredBytes, 0);
    const freeBytes = copyProbes.length > 0 ? Math.min(...copyProbes.map((probe) => probe.freeBytes)) : 0;
    const anyNetwork = collected.some((probe) => probe?.ok === true && probe.network);
    return (
      <Dialog
        open
        title={many ? intl.formatMessage(messages.titleMany, { count: ordered.length }) : intl.formatMessage(messages.titleOne)}
        icon="hard-drive"
        width={520}
        onClose={closeDialog}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog}>
              <FormattedMessage {...messages.cancel} />
            </Button>
            <Button variant="primary" disabled={root === null || anyPending || anyBlocked} onClick={start} data-testid="move-start">
              {many ? (
                <FormattedMessage {...messages.startMany} values={{ count: ordered.length }} />
              ) : (
                <FormattedMessage {...messages.startOne} />
              )}
            </Button>
          </>
        }
      >
        <ul className="ovl-libmove__sources" data-testid="move-sources">
          {ordered.map((lib) => (
            <li key={lib.id} className="ovl-libmove__source">
              <span className="ovl-libmove__source-name">
                {lib.name}
                {lib.open ? (
                  <Badge tone="cyan">
                    <FormattedMessage {...messages.openNow} />
                  </Badge>
                ) : null}
              </span>
              <span className="mono-data ovl-libmove__path">{lib.path}</span>
              {root === null ? null : (
                <span className="mono-data ovl-libmove__dest-preview">
                  <FormattedMessage {...messages.destPreview} values={{ path: destFor(lib, root, 1) }} />
                </span>
              )}
              <ReviewProbe
                probe={root === null ? undefined : probes.get(`${root}\u0000${lib.id}`)}
                pending={root !== null && !probes.has(`${root}\u0000${lib.id}`)}
              />
            </li>
          ))}
        </ul>
        {copyProbes.length > 0 ? (
          <div className="ovl-libmove__space" data-testid="move-space-meter">
            <ProgressBar
              value={Math.min(requiredBytes, freeBytes > 0 ? freeBytes : requiredBytes)}
              max={freeBytes > 0 ? freeBytes : Math.max(requiredBytes, 1)}
              tone={requiredBytes > freeBytes ? 'amber' : 'cyan'}
              label={intl.formatMessage(messages.spaceLabel)}
              detail={intl.formatMessage(messages.spaceDetail, { needed: formatBytes(requiredBytes), free: formatBytes(freeBytes) })}
            />
          </div>
        ) : null}
        {anyNetwork ? (
          <div className="ovl-libmove__note" data-testid="move-network-warning">
            <Icon name="triangle-alert" size={14} color="var(--accent-amber)" />
            <span>
              <FormattedMessage {...messages.networkWarning} />
            </span>
          </div>
        ) : null}
        <div className="ovl-libmove__label">
          <FormattedMessage {...messages.destination} />
        </div>
        <div className="ovl-libmove__location">
          <span className="mono-data ovl-libmove__location-path">{root ?? intl.formatMessage(messages.destinationPlaceholder)}</span>
          <Button size="sm" onClick={chooseRoot} data-testid="move-pick-destination">
            <FormattedMessage {...messages.choose} />
          </Button>
        </div>
        {destinationAuthorizationDenied ? (
          <div className="ovl-libmove__error" role="alert">
            <FormattedMessage {...reasonMessages['authorization-denied']} />
          </div>
        ) : null}
        <div className="ovl-libmove__reassure">
          <Icon name="shield-check" size={16} color="var(--accent-green)" />
          <span>
            <FormattedMessage {...messages.assurance} />
          </span>
        </div>
        {includesOpen ? (
          <div className="ovl-libmove__note">
            <Icon name="refresh-cw" size={14} color="var(--accent-iris)" />
            <span>
              <FormattedMessage {...messages.openNote} />
            </span>
          </div>
        ) : null}
        <div className="ovl-libmove__note ovl-libmove__note--muted">
          <FormattedMessage {...messages.backupNote} />
        </div>
      </Dialog>
    );
  }

  if (phase === 'progress') {
    const doneCount = rows.filter(
      (row) => row.status === 'moved' || row.status === 'cleanup-pending' || row.status === 'failed' || row.status === 'skipped',
    ).length;
    return (
      <Dialog open title={intl.formatMessage(messages.progressTitle)} icon="hard-drive" width={520}>
        <div role="status" aria-live="polite" data-testid="move-progress">
          <div className="mono-data ovl-libmove__counter">
            <FormattedMessage {...messages.counter} values={{ n: Math.min(doneCount + 1, ordered.length), total: ordered.length }} />
          </div>
          <ul className="ovl-libmove__rows">
            {rows.map((row) => (
              <li key={row.lib.id} className="ovl-libmove__row">
                <span className="ovl-libmove__source-name">{row.lib.name}</span>
                {row.status === 'active' && progress !== null ? (
                  <ProgressBar
                    value={progress.totalBytes > 0 ? progress.copiedBytes : 0}
                    max={progress.totalBytes > 0 ? progress.totalBytes : 1}
                    label={intl.formatMessage(messages.progressLabel, {
                      phase: intl.formatMessage(phaseMessages[progress.phase as keyof typeof phaseMessages] ?? phaseMessages.copying),
                      name: row.lib.name,
                    })}
                    detail={`${formatCount(progress.copiedItems)} / ${formatCount(progress.totalItems)} · ${formatBytes(progress.copiedBytes)}`}
                  />
                ) : (
                  <StatusBadge row={row} />
                )}
              </li>
            ))}
          </ul>
          <div className="ovl-libmove__cancel-row">
            {committed ? (
              <Button disabled>
                <FormattedMessage {...messages.finishing} />
              </Button>
            ) : (
              <Button onClick={cancelCurrent} data-testid="move-cancel">
                <FormattedMessage {...messages.cancelRollback} />
              </Button>
            )}
          </div>
        </div>
      </Dialog>
    );
  }

  const anyFailed = rows.some((row) => row.status === 'failed' || row.status === 'skipped');
  return (
    <Dialog
      open
      title={intl.formatMessage(messages.resultsTitle)}
      icon="hard-drive"
      width={560}
      onClose={closeDialog}
      footer={
        <>
          {anyFailed ? (
            <Button onClick={retryFailed} data-testid="move-retry">
              <FormattedMessage {...messages.retryFailed} />
            </Button>
          ) : null}
          <Button variant="primary" onClick={closeDialog} data-testid="move-done">
            <FormattedMessage {...messages.done} />
          </Button>
        </>
      }
    >
      <ul className="ovl-libmove__rows" data-testid="move-results">
        {rows.map((row) => (
          <li key={row.lib.id} className="ovl-libmove__result">
            <div className="ovl-libmove__result-head">
              <span className="ovl-libmove__source-name">{row.lib.name}</span>
              <StatusBadge row={row} />
            </div>
            <div className="mono-data ovl-libmove__path">
              {row.destPath === null ? (
                row.lib.path
              ) : (
                <FormattedMessage {...messages.pathArrow} values={{ from: row.lib.path, to: row.destPath }} />
              )}
            </div>
            {row.status === 'moved' && row.bytes !== undefined ? (
              <div className="mono-data ovl-libmove__result-detail">
                <FormattedMessage
                  {...messages.resultDetail}
                  values={{
                    items: formatCount(row.items ?? 0),
                    bytes: formatCount(row.bytes),
                    method: intl.formatMessage(row.mode === 'rename' ? messages.methodInstant : messages.methodCopy),
                    id: row.lib.id.slice(0, 8),
                  }}
                />
              </div>
            ) : null}
            {row.status === 'cleanup-pending' ? (
              <div className="ovl-libmove__cleanup">
                <span>
                  <FormattedMessage {...messages.cleanupCopy} />
                </span>
                <Button size="sm" onClick={() => finishCleanup(row)} data-testid={`move-finish-cleanup-${row.lib.name}`}>
                  <FormattedMessage {...messages.finishCleanup} />
                </Button>
              </div>
            ) : null}
            {row.status === 'failed' && row.reason !== undefined ? (
              <div className="ovl-libmove__error" role="alert">
                <FormattedMessage {...reasonMessages[row.reason]} />
                {row.detail === undefined ? '' : <span className="mono-data ovl-libmove__error-detail"> {row.detail}</span>}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** Per-library Review line: resolved method chip, collision note, or the
 * blocking refusal — decided copy for every designed reason (ADR-0022 §5). */
function ReviewProbe({ probe, pending }: { readonly probe: Probe | undefined; readonly pending: boolean }): ReactElement | null {
  if (pending) {
    return (
      <span className="mono-data ovl-libmove__probe-note">
        <FormattedMessage {...messages.probing} />
      </span>
    );
  }
  if (probe === undefined) return null;
  if (probe.ok) {
    // The switcher list can be stale; the probe's lock check is live. A
    // library locked since the list was read blocks like any refusal.
    if (probe.lockedBy !== null) {
      return (
        <span className="ovl-libmove__error" role="alert">
          <FormattedMessage {...reasonMessages.locked} />
        </span>
      );
    }
    return (
      <span className="ovl-libmove__probe" data-testid="move-method-chip">
        <Badge tone={probe.mode === 'rename' ? 'cyan' : 'neutral'}>
          <FormattedMessage {...(probe.mode === 'rename' ? messages.methodInstant : messages.methodCopy)} />
        </Badge>
      </span>
    );
  }
  if (probe.reason === 'destination-not-empty') {
    return (
      <span className="ovl-libmove__probe-note">
        <FormattedMessage {...messages.collisionNote} />
      </span>
    );
  }
  return (
    <span className="ovl-libmove__error" role="alert">
      <FormattedMessage {...reasonMessages[probe.reason]} />
    </span>
  );
}

function StatusBadge({ row }: { readonly row: Row }): ReactElement {
  switch (row.status) {
    case 'moved':
      return (
        <Badge tone="green">
          <FormattedMessage {...badgeMessages.moved} />
        </Badge>
      );
    case 'cleanup-pending':
      return (
        <Badge tone="amber">
          <FormattedMessage {...badgeMessages.cleanupPending} />
        </Badge>
      );
    case 'failed':
      return (
        <Badge tone="red">
          <FormattedMessage {...badgeMessages.failed} />
        </Badge>
      );
    case 'skipped':
      return (
        <Badge tone="neutral">
          <FormattedMessage {...badgeMessages.skipped} />
        </Badge>
      );
    case 'active':
      return (
        <Badge tone="cyan">
          <FormattedMessage {...badgeMessages.active} />
        </Badge>
      );
    default:
      return (
        <Badge tone="neutral">
          <FormattedMessage {...badgeMessages.waiting} />
        </Badge>
      );
  }
}
