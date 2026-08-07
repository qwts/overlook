import { useEffect, useRef, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { Button } from '../components/Button';
import { Checkbox } from '../components/Checkbox';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { ProgressBar } from '../components/ProgressBar';
import { Segmented } from '../components/Segmented';
import { Switch } from '../components/Switch';
import { useFormats } from '../i18n/use-formats.js';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { CopyableValue } from '../components/CopyableValue';

import './import.css';

const messages = defineMessages({
  moveWarningSd: {
    id: 'import.move.warning.sd',
    defaultMessage: 'Each imported original will be deleted from the card only after encrypted custody and decrypt/hash verification.',
  },
  moveWarningFolder: {
    id: 'import.move.warning.folder',
    defaultMessage:
      'Each imported original will be deleted from this folder only after encrypted custody and decrypt/hash verification. The folder and unrelated files stay.',
  },
  moveWarningDrop: {
    id: 'import.move.warning.drop',
    defaultMessage:
      'Each imported original will be deleted from its original folder only after encrypted custody and decrypt/hash verification. Folders and unrelated files stay.',
  },
  moveConsent: {
    id: 'import.move.consent',
    defaultMessage: 'I understand verified source files will be deleted and unverified files will be retained.',
  },
  moveComplete: {
    id: 'import.move.complete',
    defaultMessage: '{moved} moved · {retained} retained after encrypted custody verification.',
  },
  copySourcePath: { id: 'import.copy.sourcePath', defaultMessage: 'import source path' },
});

// ImportDialog (#88, sources reworked by #237): the design's 440px import
// flow over the real engine. A segmented source picker — SD card / Local
// folder, plus Dropped when the window drop opened the dialog — feeds the
// same options → running (two aggregate bars) → done flow. Local sources may
// Move through the verified per-file cleanup path, with a fresh confirmation
// every time; Google Drive remains Copy-only (#489).

export type ImportSourceKind = 'sd' | 'folder' | 'drop' | 'google-drive';

interface ScanSummary {
  readonly total: number;
  readonly newCount: number;
  readonly newBytes: number;
  readonly newRaw: number;
  readonly newJpg: number;
  /** Companion sidecars attached to NEW media (#484). */
  readonly newSidecars: number;
  /** Allowlisted companions matching no media — reported, never dropped. */
  readonly unmatchedCompanions: number;
}

/** Natural-case source text; mono-data applies the visual uppercase treatment. */
function summaryDetail(summary: ScanSummary, formatCount: (value: number) => string, formatBytes: (bytes: number) => string): string {
  const base = `${formatCount(summary.newCount)} new · ${formatBytes(summary.newBytes)} · ${formatCount(summary.newRaw)} RAW / ${formatCount(summary.newJpg)} JPG`;
  return summary.newSidecars > 0 ? `${base} · ${formatCount(summary.newSidecars)} sidecar${summary.newSidecars === 1 ? '' : 's'}` : base;
}

/** Honest companion reporting (#484): allowlisted sidecars whose stem matched
 * no media are named in the card, never silently discarded. */
function unmatchedCompanionNote(summary: ScanSummary, formatCount: (value: number) => string): string | null {
  if (summary.unmatchedCompanions === 0) return null;
  return `${formatCount(summary.unmatchedCompanions)} sidecar file${summary.unmatchedCompanions === 1 ? '' : 's'} without a matching photo skipped`;
}

type SdState =
  | { readonly status: 'scanning' }
  | { readonly status: 'none' }
  | { readonly status: 'ready'; readonly path: string; readonly label: string; readonly summary: ScanSummary };

type FolderState =
  | { readonly status: 'empty' }
  | { readonly status: 'scanning'; readonly path: string }
  | { readonly status: 'ready'; readonly path: string; readonly summary: ScanSummary };

type DropState = { readonly status: 'scanning' } | { readonly status: 'ready'; readonly summary: ScanSummary };

type GoogleDriveState =
  | { readonly status: 'empty' }
  | { readonly status: 'picking' }
  | {
      readonly status: 'ready';
      readonly selectionId: string;
      readonly summary: ScanSummary;
      readonly skipped: number;
    }
  | {
      readonly status: 'error';
      readonly reason: 'cancelled' | 'unavailable' | 'busy' | 'authorization-failed' | 'no-supported-files' | 'download-failed';
    };

const GOOGLE_DRIVE_ERROR: Readonly<Record<Extract<GoogleDriveState, { status: 'error' }>['reason'], string>> = {
  cancelled: 'No Google Drive photos selected',
  unavailable: 'Google Drive import is unavailable in this build',
  busy: 'A Google Drive selection is already open',
  'authorization-failed': 'Could not connect to Google Drive',
  'no-supported-files': 'No supported photos were selected',
  'download-failed': 'Selected photos could not be downloaded',
};

export interface ImportDialogProps {
  readonly open: boolean;
  /** Paths dropped onto the window (#237); null when opened from the toolbar. */
  readonly dropped: readonly string[] | null;
  readonly onClose: () => void;
  /** "Show in library" — the shell jumps to Recent imports (E6.7). */
  readonly onDone: () => void;
  /** The dropped paths resolved, but none passed the shared media allowlist. */
  readonly onRejectedDrop?: (() => void) | undefined;
  /** Clean completion (no failures): feeds the green toast (#89). Fired
   * when the dialog CLOSES — never while the modal scrim still covers the
   * toast layer and burns its 4s timer (PR #185 review). */
  readonly onComplete?: ((imported: number) => void) | undefined;
}

type Phase = 'options' | 'running' | 'done';

interface Bar {
  readonly done: number;
  readonly total: number;
}

export function ImportDialog({ open, dropped, onClose, onDone, onRejectedDrop, onComplete }: ImportDialogProps): ReactElement | null {
  const intl = useIntl();
  const { announce } = useAnnouncer();
  const { formatBytes, formatCount } = useFormats();
  const [phase, setPhase] = useState<Phase>('options');
  const [mode, setMode] = useState<'copy' | 'move'>('copy');
  const [moveConfirmed, setMoveConfirmed] = useState(false);
  const [source, setSource] = useState<ImportSourceKind>(dropped === null ? 'sd' : 'drop');
  const [sd, setSd] = useState<SdState>({ status: 'scanning' });
  const [folder, setFolder] = useState<FolderState>({ status: 'empty' });
  const [drop, setDrop] = useState<DropState>({ status: 'scanning' });
  const [googleDrive, setGoogleDrive] = useState<GoogleDriveState>({ status: 'empty' });
  const googlePickRequestRef = useRef(0);
  // A drop can land while the dialog is already open (toolbar-opened, or a
  // second drop): re-select the Dropped segment so the footer imports what
  // the user just dropped (PR #249 review). During-render adjustment, per
  // the repo's set-state-in-effect stance.
  const [seenDropped, setSeenDropped] = useState(dropped);
  if (dropped !== seenDropped) {
    setSeenDropped(dropped);
    if (dropped !== null) {
      setSource('drop');
      setDrop({ status: 'scanning' });
      setMoveConfirmed(false);
    }
  }

  // "On import" is the SAME setting as Settings → Storage & Backup (#114):
  // changes persist back. A stored Move preference never silently arms
  // deletion on a fresh dialog: Move always requires a new confirmation.
  useEffect(() => {
    void window.overlook.settings.get().then(({ settings }) => {
      setMode(settings.importMode);
    });
  }, []);
  const chooseMode = (importMode: 'copy' | 'move'): void => {
    setMode(importMode);
    setMoveConfirmed(false);
    void window.overlook.settings.set({ patch: { importMode } }).catch(() => undefined);
  };

  // SD discovery (#237): the first mounted volume, scanned for the card.
  useEffect(() => {
    let stale = false;
    void window.overlook.import
      .listSources()
      .then(async ({ sources }) => {
        const volume = sources.find((candidate) => candidate.kind === 'volume');
        if (volume === undefined) {
          if (!stale) {
            setSd({ status: 'none' });
          }
          return;
        }
        const summary = await window.overlook.import.scanSource({ path: volume.path });
        if (!stale) {
          setSd({ status: 'ready', path: volume.path, label: volume.label, summary });
        }
      })
      .catch(() => {
        if (!stale) {
          setSd({ status: 'none' });
        }
      });
    return () => {
      stale = true;
    };
  }, []);

  // Dropped files (#237): scanned through the same allowlist + NEW dedupe.
  useEffect(() => {
    if (dropped === null) {
      return;
    }
    let stale = false;
    void window.overlook.import
      .scanFiles({ paths: [...dropped] })
      .then((summary) => {
        if (!stale) {
          if (summary.total === 0) {
            onRejectedDrop?.();
            return;
          }
          setDrop({ status: 'ready', summary });
        }
      })
      .catch(() => {
        if (!stale) {
          setDrop({
            status: 'ready',
            summary: { total: 0, newCount: 0, newBytes: 0, newRaw: 0, newJpg: 0, newSidecars: 0, unmatchedCompanions: 0 },
          });
        }
      });
    return () => {
      stale = true;
    };
  }, [dropped, onRejectedDrop]);

  const chooseFolder = (): void => {
    setMoveConfirmed(false);
    void window.overlook.import
      .pickFolder()
      .then(async ({ path }) => {
        if (path === null) {
          return;
        }
        setMoveConfirmed(false);
        setFolder({ status: 'scanning', path });
        const summary = await window.overlook.import.scanSource({ path });
        setFolder({ status: 'ready', path, summary });
      })
      .catch(() => {
        setFolder({ status: 'empty' });
      });
  };

  const chooseGoogleDrive = (): void => {
    const request = googlePickRequestRef.current + 1;
    googlePickRequestRef.current = request;
    setGoogleDrive({ status: 'picking' });
    void window.overlook.import
      .pickGoogleDrive()
      .then((result) => {
        if (request !== googlePickRequestRef.current) {
          if (result.status === 'ready') {
            void window.overlook.import.discardGoogleDrive({ selectionId: result.selectionId }).catch(() => undefined);
          }
          return;
        }
        setGoogleDrive(
          result.status === 'ready'
            ? {
                status: 'ready',
                selectionId: result.selectionId,
                summary: result.summary,
                skipped: result.skipped,
              }
            : { status: 'error', reason: result.status },
        );
      })
      .catch(() => {
        if (request === googlePickRequestRef.current) setGoogleDrive({ status: 'error', reason: 'authorization-failed' });
      });
  };

  useEffect(
    () => () => {
      googlePickRequestRef.current += 1;
      void window.overlook.import.cancelGoogleDrivePick().catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if (!open) {
      googlePickRequestRef.current += 1;
      void window.overlook.import.cancelGoogleDrivePick().catch(() => undefined);
    }
  }, [open]);

  useEffect(() => {
    if (googleDrive.status !== 'ready') return;
    const selectionId = googleDrive.selectionId;
    return () => {
      void window.overlook.import.discardGoogleDrive({ selectionId }).catch(() => undefined);
    };
  }, [googleDrive]);

  const [copyBar, setCopyBar] = useState<Bar>({ done: 0, total: 0 });
  const [thumbBar, setThumbBar] = useState<Bar>({ done: 0, total: 0 });
  const [imported, setImported] = useState(0);
  const [sidecars, setSidecars] = useState(0);
  const [moved, setMoved] = useState(0);
  const [retained, setRetained] = useState(0);
  const [duplicates, setDuplicates] = useState(0);
  const [failed, setFailed] = useState(0);
  const [runError, setRunError] = useState(false);
  const [cancelled, setCancelled] = useState(0);
  const [cleanCount, setCleanCount] = useState<number | null>(null);

  useEffect(() => {
    if (phase !== 'running') {
      return;
    }
    const offCopy = window.overlook.import.onCopyProgress((payload) => {
      setCopyBar(payload);
    });
    const offThumb = window.overlook.import.onThumbProgress((payload) => {
      setThumbBar(payload);
    });
    return () => {
      offCopy();
      offThumb();
    };
  }, [phase]);

  const copyQuarter = copyBar.total === 0 ? -1 : Math.floor((copyBar.done / copyBar.total) * 4);
  const thumbQuarter = thumbBar.total === 0 ? -1 : Math.floor((thumbBar.done / thumbBar.total) * 4);
  const announcedCopyQuarter = useRef(-2);
  const announcedThumbQuarter = useRef(-2);
  useEffect(() => {
    if (phase !== 'running' || copyQuarter < 0 || announcedCopyQuarter.current === copyQuarter) return;
    announcedCopyQuarter.current = copyQuarter;
    announce(
      `${source !== 'google-drive' && mode === 'move' ? 'Moving and encrypting' : 'Copying and encrypting'}: ${formatCount(copyBar.done)} of ${formatCount(copyBar.total)}`,
      'polite',
      'import-copy-progress',
    );
  }, [announce, copyBar.done, copyBar.total, copyQuarter, formatCount, mode, phase, source]);
  useEffect(() => {
    if (phase !== 'running' || thumbQuarter < 0 || announcedThumbQuarter.current === thumbQuarter) return;
    announcedThumbQuarter.current = thumbQuarter;
    announce(
      `Generating thumbnails: ${formatCount(thumbBar.done)} of ${formatCount(thumbBar.total)}`,
      'polite',
      'import-thumbnail-progress',
    );
  }, [announce, formatCount, phase, thumbBar.done, thumbBar.total, thumbQuarter]);
  const previousSdStatus = useRef(sd.status);
  useEffect(() => {
    if (previousSdStatus.current === sd.status) return;
    previousSdStatus.current = sd.status;
    announce(
      sd.status === 'ready'
        ? `SD card detected: ${sd.label}`
        : sd.status === 'none'
          ? 'SD card status: no card detected'
          : 'Looking for cards',
      'polite',
      'sd-card-status',
    );
  }, [announce, sd]);

  if (!open) {
    return null;
  }

  const usingSd = source === 'sd';
  const moveAllowed = source !== 'google-drive';
  const importMode = moveAllowed ? mode : 'copy';
  const moveReady = importMode !== 'move' || moveConfirmed;
  const activeSummary =
    source === 'google-drive'
      ? googleDrive.status === 'ready'
        ? googleDrive.summary
        : null
      : source === 'drop'
        ? drop.status === 'ready'
          ? drop.summary
          : null
        : source === 'sd'
          ? sd.status === 'ready'
            ? sd.summary
            : null
          : folder.status === 'ready'
            ? folder.summary
            : null;
  const total = activeSummary?.newCount ?? 0;
  const available = activeSummary !== null && total > 0;

  const close = (showRecent: boolean): void => {
    googlePickRequestRef.current += 1;
    void window.overlook.import.cancelGoogleDrivePick().catch(() => undefined);
    if (cleanCount !== null) {
      onComplete?.(cleanCount); // the modal is gone — the toast is visible
    }
    if (showRecent) {
      onDone();
    }
    onClose();
  };

  const start = (): void => {
    setPhase('running');
    setCopyBar({ done: 0, total });
    setThumbBar({ done: 0, total });
    const run =
      source === 'google-drive'
        ? googleDrive.status === 'ready'
          ? window.overlook.import.runGoogleDrive({ selectionId: googleDrive.selectionId })
          : Promise.reject(new Error('Google Drive selection is unavailable'))
        : source === 'drop'
          ? window.overlook.import.run({ files: [...(dropped ?? [])], mode: importMode })
          : window.overlook.import.run({
              path: source === 'sd' ? (sd.status === 'ready' ? sd.path : '') : folder.status === 'ready' ? folder.path : '',
              mode: importMode,
            });
    void run
      .then((summary) => {
        setImported(summary.imported);
        setSidecars(summary.sidecars);
        setMoved(summary.moved);
        setRetained(summary.retained);
        setDuplicates(summary.duplicates);
        setFailed(summary.failed);
        setCancelled(summary.cancelled);
        setPhase('done');
        if (summary.failed > 0) {
          announce(`Import finished with ${formatCount(summary.failed)} ${summary.failed === 1 ? 'failure' : 'failures'}`, 'assertive');
        } else if (summary.cancelled > 0) {
          announce(`Import cancelled after ${formatCount(summary.imported)} ${summary.imported === 1 ? 'photo' : 'photos'}`);
        } else if (importMode === 'move' && summary.retained > 0) {
          announce(`${formatCount(summary.retained)} source ${summary.retained === 1 ? 'file was' : 'files were'} retained`, 'assertive');
        } else {
          announce(
            `Import complete: ${formatCount(summary.imported)} ${summary.imported === 1 ? 'photo' : 'photos'} imported and encrypted`,
          );
        }
        if (summary.failed === 0 && summary.cancelled === 0 && (importMode === 'copy' || summary.retained === 0)) {
          setCleanCount(summary.imported);
        }
      })
      .catch(() => {
        // The run itself died (source vanished mid-scan): nothing on the
        // card was deleted (Move cleanup only follows verification).
        setRunError(true);
        setPhase('done');
        announce('Import failed. Source files were left untouched.', 'assertive');
      });
  };

  return (
    <Dialog
      open={open}
      title="Import photos"
      icon="download"
      width={440}
      onClose={
        phase === 'running'
          ? undefined
          : () => {
              close(false);
            }
      }
      footer={
        phase === 'options' ? (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                close(false);
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" icon="download" disabled={!available || !moveReady} onClick={start}>
              {available ? `Import ${formatCount(total)} photos` : 'Import'}
            </Button>
          </>
        ) : phase === 'running' ? (
          <Button
            variant="ghost"
            onClick={() => {
              // Cancel semantics (#88): the engine finishes the file in
              // flight and keeps everything completed; the run's own
              // resolution moves us to the done summary.
              void window.overlook.import.cancel({});
            }}
          >
            Cancel
          </Button>
        ) : phase === 'done' ? (
          <Button
            variant="primary"
            onClick={() => {
              close(true);
            }}
          >
            Show in library
          </Button>
        ) : null
      }
    >
      {phase === 'options' ? (
        <div className="ovl-import__options">
          <div>
            <div className="ovl-import__pickerLabel mono-data">Import from</div>
            <Segmented
              label="Import from"
              value={source}
              onChange={(nextSource) => {
                setSource(nextSource);
                setMoveConfirmed(false);
              }}
              options={[
                ...(dropped === null ? [] : [{ value: 'drop' as const, icon: 'image' as const, label: 'Dropped' }]),
                { value: 'sd' as const, icon: 'hard-drive' as const, label: 'SD card' },
                { value: 'folder' as const, icon: 'folder' as const, label: 'Local folder' },
                { value: 'google-drive' as const, icon: 'cloud' as const, label: 'Google Drive' },
              ]}
            />
          </div>
          {source === 'google-drive' ? (
            googleDrive.status === 'ready' ? (
              <div className="ovl-import__card" data-testid="import-source-card">
                <Icon name="cloud" size={16} color="var(--accent-cyan)" />
                <div className="ovl-import__cardText">
                  <div className="ovl-import__cardTitle">
                    {formatCount(googleDrive.summary.total)} photo{googleDrive.summary.total === 1 ? '' : 's'} selected from Google Drive
                  </div>
                  <div className="ovl-import__cardMeta mono-data">{summaryDetail(googleDrive.summary, formatCount, formatBytes)}</div>
                  {googleDrive.skipped > 0 ? (
                    <div className="ovl-import__cardMeta mono-data">
                      {formatCount(googleDrive.skipped)} unsupported or unavailable file{googleDrive.skipped === 1 ? '' : 's'} skipped
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="ovl-import__clear"
                  aria-label="Clear Google Drive selection"
                  onClick={() => {
                    setGoogleDrive({ status: 'empty' });
                  }}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            ) : googleDrive.status === 'picking' ? (
              <div className="ovl-import__card">
                <Icon name="cloud" size={16} />
                <div className="ovl-import__cardText">
                  <div className="ovl-import__cardMeta mono-data">Waiting for Google Drive selection in your browser…</div>
                </div>
              </div>
            ) : (
              <button type="button" className="ovl-import__empty ovl-import__empty--action" onClick={chooseGoogleDrive}>
                <Icon name="cloud" size={20} color="var(--text-faint)" />
                <div className="ovl-import__emptyTitle">
                  {googleDrive.status === 'error' ? GOOGLE_DRIVE_ERROR[googleDrive.reason] : 'Choose photos from Google Drive'}
                </div>
                <div className="ovl-import__emptyHint">
                  {googleDrive.status === 'error' ? 'Try again' : 'Opens Google’s secure file picker in your browser'}
                </div>
              </button>
            )
          ) : source === 'drop' ? (
            drop.status === 'ready' ? (
              <div className="ovl-import__card" data-testid="import-source-card">
                <Icon name="image" size={16} color="var(--accent-cyan)" />
                <div className="ovl-import__cardText">
                  <div className="ovl-import__cardTitle">
                    {formatCount(drop.summary.newCount)} photo{drop.summary.newCount === 1 ? '' : 's'} ready to import
                  </div>
                  <div className="ovl-import__cardMeta mono-data">{summaryDetail(drop.summary, formatCount, formatBytes)}</div>
                  {unmatchedCompanionNote(drop.summary, formatCount) === null ? null : (
                    <div className="ovl-import__cardMeta mono-data" data-testid="import-unmatched-companions">
                      {unmatchedCompanionNote(drop.summary, formatCount)}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="ovl-import__card">
                <Icon name="image" size={16} />
                <div className="ovl-import__cardText">
                  <div className="ovl-import__cardMeta mono-data">Scanning dropped files…</div>
                </div>
              </div>
            )
          ) : usingSd ? (
            sd.status === 'ready' ? (
              <div className="ovl-import__card" data-testid="import-source-card">
                <Icon name="hard-drive" size={16} />
                <div className="ovl-import__cardText">
                  <div className="ovl-import__cardTitle">{sd.label}</div>
                  <div className="ovl-import__cardMeta mono-data">{summaryDetail(sd.summary, formatCount, formatBytes)}</div>
                  {unmatchedCompanionNote(sd.summary, formatCount) === null ? null : (
                    <div className="ovl-import__cardMeta mono-data">{unmatchedCompanionNote(sd.summary, formatCount)}</div>
                  )}
                </div>
              </div>
            ) : sd.status === 'scanning' ? (
              <div className="ovl-import__card">
                <Icon name="hard-drive" size={16} />
                <div className="ovl-import__cardText">
                  <div className="ovl-import__cardMeta mono-data">Looking for cards…</div>
                </div>
              </div>
            ) : (
              <div className="ovl-import__empty" data-testid="import-no-card">
                <Icon name="hard-drive" size={20} color="var(--text-faint)" />
                <div className="ovl-import__emptyTitle">No SD card detected</div>
                <div className="ovl-import__emptyHint">
                  Insert a card, or switch to{' '}
                  <button
                    type="button"
                    className="ovl-import__link"
                    onClick={() => {
                      setSource('folder');
                      setMoveConfirmed(false);
                    }}
                  >
                    Local folder
                  </button>
                  .
                </div>
              </div>
            )
          ) : folder.status === 'ready' || folder.status === 'scanning' ? (
            <div className="ovl-import__card" data-testid="import-source-card">
              <Icon name="folder" size={16} color="var(--accent-cyan)" />
              <div className="ovl-import__cardText">
                <CopyableValue
                  value={folder.path}
                  label={intl.formatMessage(messages.copySourcePath)}
                  className="ovl-import__cardPathValue"
                  textClassName="ovl-import__cardPath"
                />
                <div className="ovl-import__cardMeta mono-data">
                  {folder.status === 'ready' ? summaryDetail(folder.summary, formatCount, formatBytes) : 'Scanning…'}
                </div>
                {folder.status === 'ready' && unmatchedCompanionNote(folder.summary, formatCount) !== null ? (
                  <div className="ovl-import__cardMeta mono-data">{unmatchedCompanionNote(folder.summary, formatCount)}</div>
                ) : null}
              </div>
              <button
                type="button"
                className="ovl-import__clear"
                aria-label="Clear folder"
                onClick={() => {
                  setFolder({ status: 'empty' });
                  setMoveConfirmed(false);
                }}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          ) : (
            <button type="button" className="ovl-import__empty ovl-import__empty--action" onClick={chooseFolder}>
              <Icon name="folder-open" size={20} color="var(--text-faint)" />
              <div className="ovl-import__emptyTitle">Choose a folder to import</div>
              <div className="ovl-import__emptyHint">Scans for photos, including subfolders</div>
            </button>
          )}
          <Checkbox checked label="Generate thumbnails on import" />
          <div className={`ovl-import__row${moveAllowed ? '' : ' ovl-import__row--locked'}`}>
            <span>On import</span>
            <Segmented
              label="On import"
              value={importMode}
              disabled={!moveAllowed}
              onChange={chooseMode}
              options={[
                { value: 'copy', label: 'Copy' },
                { value: 'move', label: 'Move' },
              ]}
            />
          </div>
          {moveAllowed && mode === 'move' ? (
            <div className="ovl-import__warning mono-data" role="alert">
              <Icon name="triangle-alert" size={12} />
              {usingSd
                ? intl.formatMessage(messages.moveWarningSd)
                : source === 'folder'
                  ? intl.formatMessage(messages.moveWarningFolder)
                  : intl.formatMessage(messages.moveWarningDrop)}
            </div>
          ) : null}
          {moveAllowed && mode === 'move' ? (
            <Checkbox checked={moveConfirmed} onChange={setMoveConfirmed} label={intl.formatMessage(messages.moveConsent)} />
          ) : !moveAllowed ? (
            <div className="ovl-import__note mono-data">
              <Icon name="info" size={12} />
              Imported files are copied — source files are left untouched.
            </div>
          ) : null}
          <div className="ovl-import__row">
            <Switch checked disabled label="Encrypt originals (always on)" />
            <span className="ovl-import__lock">
              <Icon name="lock" size={13} />
            </span>
          </div>
        </div>
      ) : (
        <div className="ovl-import__running">
          <ProgressBar
            label={importMode === 'move' ? 'Moving & encrypting' : 'Copying & encrypting'}
            tone="green"
            value={copyBar.done}
            max={Math.max(copyBar.total, 1)}
            detail={`${formatCount(copyBar.done)} / ${formatCount(copyBar.total)}`}
          />
          <ProgressBar
            label="Generating thumbnails"
            tone="cyan"
            value={thumbBar.done}
            max={Math.max(thumbBar.total, 1)}
            detail={`${formatCount(thumbBar.done)} / ${formatCount(thumbBar.total)}`}
          />
          {phase === 'done' ? (
            runError || failed > 0 || cancelled > 0 || (importMode === 'move' && retained > 0) ? (
              <div className="ovl-import__failed" role="alert">
                <Icon name="triangle-alert" size={15} />
                {runError
                  ? 'Import failed — nothing was deleted from the source. Check the source and try again.'
                  : `${[
                      `${formatCount(imported)} imported`,
                      ...(sidecars > 0 ? [`${formatCount(sidecars)} sidecar${sidecars === 1 ? '' : 's'}`] : []),
                      ...(importMode === 'move' ? [`${formatCount(moved)} moved`, `${formatCount(retained)} retained`] : []),
                      ...(duplicates > 0 ? [`${formatCount(duplicates)} duplicate${duplicates === 1 ? '' : 's'}`] : []),
                      ...(failed > 0 ? [`${formatCount(failed)} failed`] : []),
                      ...(cancelled > 0 ? [`${formatCount(cancelled)} cancelled`] : []),
                    ].join(' · ')} — every retained source remains untouched.`}
              </div>
            ) : importMode === 'move' ? (
              <div className="ovl-import__done">
                <Icon name="shield-check" size={15} />
                {intl.formatMessage(messages.moveComplete, { moved: formatCount(moved), retained: formatCount(retained) })}
              </div>
            ) : (
              <div className="ovl-import__done">
                <Icon name="shield-check" size={15} />
                All {formatCount(imported)} photos imported and encrypted.
              </div>
            )
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
