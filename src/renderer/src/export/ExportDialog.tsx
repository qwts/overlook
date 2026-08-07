import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { ProgressBar } from '../components/ProgressBar';
import { Segmented } from '../components/Segmented';
import { Switch } from '../components/Switch';
import { useFormats } from '../i18n/use-formats.js';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { CopyableValue } from '../components/CopyableValue';

import './export.css';

const messages = defineMessages({
  allPhotos: { id: 'export.allPhotos', defaultMessage: 'Export all photos' },
  everyPhoto: { id: 'export.everyPhoto', defaultMessage: 'Every photo in this library' },
  unencryptedOriginals: { id: 'export.unencryptedOriginals', defaultMessage: 'Unencrypted originals' },
  allPhotosHint: {
    id: 'export.allPhotosHint',
    defaultMessage: 'Every original will be written as a plain, openable file to the folder you choose.',
  },
  itemFailures: { id: 'export.itemFailures', defaultMessage: 'View item failures' },
  copyDestination: { id: 'export.copy.destination', defaultMessage: 'export destination' },
  copyFailure: { id: 'export.copy.failure', defaultMessage: 'export failure' },
  metadata: { id: 'export.metadata.label', defaultMessage: 'Metadata' },
  metadataSource: { id: 'export.metadata.source', defaultMessage: 'Source' },
  metadataEdits: { id: 'export.metadata.edits', defaultMessage: 'Edits' },
  metadataNone: { id: 'export.metadata.none', defaultMessage: 'None' },
  metadataSourceHint: {
    id: 'export.metadata.sourceHint',
    defaultMessage: 'Copy retained source sidecars when originals are exported.',
  },
  metadataEditsHint: {
    id: 'export.metadata.editsHint',
    defaultMessage: 'Write title, description, and effective tags to a new XMP sidecar.',
  },
  metadataNoneHint: { id: 'export.metadata.noneHint', defaultMessage: 'Write no metadata sidecars.' },
});

// ExportDialog (#99): the design's 420px export flow, safety copy verbatim
// (README §6 + Content voice). The decrypt switch is ON by default; OFF
// disables Export and shows the amber warning — v1 ships no encrypted-export
// format (decision recorded on #97/#98). The host mounts a fresh instance
// per invocation, so state needs no reset.

export interface ExportDialogProps {
  readonly open: boolean;
  /** The selection to export. */
  readonly photoIds: readonly string[];
  /** Export all ordinary visible library photos through the main-process scope. */
  readonly allPhotos?: boolean | undefined;
  readonly onClose: () => void;
}

type Phase = 'options' | 'running' | 'done';

interface Bar {
  readonly done: number;
  readonly total: number;
}

export function ExportDialog({ open, photoIds, allPhotos = false, onClose }: ExportDialogProps): ReactElement | null {
  const intl = useIntl();
  const { formatCount } = useFormats();
  const { announce } = useAnnouncer();
  const formatLabelId = useId();
  const destinationLabelId = useId();
  const metadataLabelId = useId();
  const [phase, setPhase] = useState<Phase>('options');
  const [format, setFormat] = useState<'original' | 'jpeg'>('original');
  const [metadata, setMetadata] = useState<'original' | 'overlook' | 'none'>('original');
  const [decrypt, setDecrypt] = useState(true);
  const [destination, setDestination] = useState<string | null>(null);
  const [bar, setBar] = useState<Bar>({ done: 0, total: allPhotos ? 0 : photoIds.length });
  const [exported, setExported] = useState(0);
  const [failed, setFailed] = useState(0);
  const [failures, setFailures] = useState<readonly { readonly fileName: string; readonly reason: string }[]>([]);
  const [cancelled, setCancelled] = useState(0);
  const [previewTranscodes, setPreviewTranscodes] = useState(0);
  const [runError, setRunError] = useState(false);

  useEffect(() => {
    if (phase !== 'running') {
      return;
    }
    return window.overlook.export.onProgress((payload) => {
      setBar(payload);
    });
  }, [phase]);

  const progressQuarter = bar.total === 0 ? -1 : Math.floor((bar.done / bar.total) * 4);
  const announcedProgressQuarter = useRef(-2);
  useEffect(() => {
    if (phase !== 'running' || progressQuarter < 0 || announcedProgressQuarter.current === progressQuarter) return;
    announcedProgressQuarter.current = progressQuarter;
    announce(
      `${decrypt ? 'Decrypting and writing files' : 'Writing files'}: ${formatCount(bar.done)} of ${formatCount(bar.total)}`,
      'polite',
      'export-progress',
    );
  }, [announce, bar.done, bar.total, decrypt, formatCount, phase, progressQuarter]);

  if (!open) {
    return null;
  }

  const count = photoIds.length;
  const noun = count === 1 ? 'photo' : 'photos';
  const exportLabel = allPhotos ? intl.formatMessage(messages.allPhotos) : `Export ${formatCount(count)} ${noun}`;

  const start = (): void => {
    if (destination === null) {
      return;
    }
    setPhase('running');
    const run = allPhotos
      ? window.overlook.export.runAll({ destination, metadata })
      : window.overlook.export.run({ photoIds: [...photoIds], destination, format, metadata });
    void run
      .then((summary) => {
        setExported(summary.exported);
        setFailed(summary.failed);
        setFailures(summary.failures);
        setCancelled(summary.cancelled);
        setPreviewTranscodes(summary.previewTranscodes);
        setPhase('done');
        if (summary.failed > 0) {
          announce(`Export finished with ${formatCount(summary.failed)} ${summary.failed === 1 ? 'failure' : 'failures'}`, 'assertive');
        } else if (summary.cancelled > 0) {
          announce(`Export cancelled after ${formatCount(summary.exported)} ${summary.exported === 1 ? 'photo' : 'photos'}`);
        } else {
          announce(
            `Export complete: ${formatCount(summary.exported)} ${summary.exported === 1 ? 'photo' : 'photos'} exported and decrypted`,
          );
        }
      })
      .catch(() => {
        setRunError(true);
        setPhase('done');
        announce('Export failed. No source photos were changed.', 'assertive');
      });
  };

  return (
    <Dialog
      open={open}
      title="Export"
      icon="share"
      width={420}
      onClose={phase === 'running' ? undefined : onClose}
      footer={
        phase === 'options' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" icon="share" disabled={!decrypt || destination === null} onClick={start}>
              {exportLabel}
            </Button>
          </>
        ) : phase === 'running' ? (
          <Button
            variant="ghost"
            onClick={() => {
              void window.overlook.export.cancel({});
            }}
          >
            Cancel
          </Button>
        ) : (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        )
      }
    >
      {phase === 'options' ? (
        <div className="ovl-export__options">
          <div className="ovl-export__card">
            <Icon name="image" size={16} />
            <div className="ovl-export__cardTitle">
              {allPhotos ? intl.formatMessage(messages.everyPhoto) : `${formatCount(count)} ${noun} selected`}
            </div>
          </div>
          {allPhotos ? null : (
            <div className="ovl-export__row" role="group" aria-labelledby={formatLabelId}>
              <span id={formatLabelId}>Format</span>
              <Segmented
                label="Format"
                value={format}
                onChange={setFormat}
                options={[
                  { value: 'original', label: 'Original' },
                  { value: 'jpeg', label: 'JPEG' },
                ]}
              />
            </div>
          )}
          <div className="ovl-export__row" role="group" aria-labelledby={metadataLabelId}>
            <span id={metadataLabelId}>{intl.formatMessage(messages.metadata)}</span>
            <Segmented
              label={intl.formatMessage(messages.metadata)}
              value={metadata}
              onChange={setMetadata}
              options={[
                { value: 'original', label: intl.formatMessage(messages.metadataSource) },
                { value: 'overlook', label: intl.formatMessage(messages.metadataEdits) },
                { value: 'none', label: intl.formatMessage(messages.metadataNone) },
              ]}
            />
          </div>
          <div className="ovl-export__metadataHint">
            {intl.formatMessage(
              metadata === 'original'
                ? messages.metadataSourceHint
                : metadata === 'overlook'
                  ? messages.metadataEditsHint
                  : messages.metadataNoneHint,
            )}
          </div>
          <div className="ovl-export__decrypt">
            <div>
              <div className="ovl-export__decryptTitle">
                {allPhotos ? intl.formatMessage(messages.unencryptedOriginals) : 'Decrypt originals'}
              </div>
              <div className="ovl-export__decryptHint">
                {allPhotos
                  ? intl.formatMessage(messages.allPhotosHint)
                  : 'Files are stored encrypted. Turn this on to write plain, openable files to disk.'}
              </div>
            </div>
            {allPhotos ? null : <Switch checked={decrypt} onChange={setDecrypt} label="Decrypt originals" />}
          </div>
          {!decrypt ? (
            <div className="ovl-export__warning mono-data" role="alert">
              <Icon name="triangle-alert" size={12} />
              Without decryption, exported files can&apos;t be opened outside Overlook.
            </div>
          ) : null}
          <div className="ovl-export__row" role="group" aria-labelledby={destinationLabelId}>
            <span id={destinationLabelId}>Destination</span>
            <Button
              variant="secondary"
              icon="folder"
              size="sm"
              onClick={() => {
                void window.overlook.export.pickDestination({}).then(({ path }) => {
                  if (path !== null) {
                    setDestination(path);
                  }
                });
              }}
            >
              {destination === null ? 'Choose folder…' : (destination.split('/').at(-1) ?? destination)}
            </Button>
          </div>
          {destination === null ? null : (
            <CopyableValue
              value={destination}
              label={intl.formatMessage(messages.copyDestination)}
              className="ovl-export__destinationPath"
            />
          )}
        </div>
      ) : (
        <div className="ovl-export__running">
          <ProgressBar
            label={decrypt ? 'Decrypting & writing files' : 'Writing files'}
            tone="cyan"
            value={bar.done}
            max={Math.max(bar.total, 1)}
            detail={`${formatCount(bar.done)} / ${formatCount(bar.total)}`}
          />
          {phase === 'done' ? (
            runError || failed > 0 || cancelled > 0 ? (
              <div className="ovl-export__failed" role="alert">
                <Icon name="triangle-alert" size={15} />
                {runError
                  ? 'Export failed — check the destination and try again.'
                  : `${[
                      `${formatCount(exported)} exported`,
                      ...(failed > 0 ? [`${formatCount(failed)} failed`] : []),
                      ...(cancelled > 0 ? [`${formatCount(cancelled)} cancelled`] : []),
                    ].join(' · ')}.`}
                {failures.length > 0 ? (
                  <details>
                    <summary>{intl.formatMessage(messages.itemFailures)}</summary>
                    <ul>
                      {failures.map(({ fileName, reason }) => (
                        <li key={`${fileName}:${reason}`}>
                          <CopyableValue
                            value={`${fileName}: ${reason}`}
                            label={intl.formatMessage(messages.copyFailure)}
                            className="ovl-export__failureValue"
                          />
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ) : (
              <div className="ovl-export__done">
                <Icon name="circle-check" size={15} />
                {formatCount(exported)} {exported === 1 ? 'photo' : 'photos'} exported and decrypted.
                {previewTranscodes > 0 ? ` ${formatCount(previewTranscodes)} from RAW previews (preview resolution).` : ''}
              </div>
            )
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
