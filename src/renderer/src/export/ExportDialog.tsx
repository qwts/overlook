import { useEffect, useId, useRef, useState, type ReactElement } from 'react';

import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { ProgressBar } from '../components/ProgressBar';
import { Segmented } from '../components/Segmented';
import { Switch } from '../components/Switch';
import { useFormats } from '../i18n/use-formats.js';
import { useAnnouncer } from '../components/LiveAnnouncer';

import './export.css';

// ExportDialog (#99): the design's 420px export flow, safety copy verbatim
// (README §6 + Content voice). The decrypt switch is ON by default; OFF
// disables Export and shows the amber warning — v1 ships no encrypted-export
// format (decision recorded on #97/#98). The host mounts a fresh instance
// per invocation, so state needs no reset.

export interface ExportDialogProps {
  readonly open: boolean;
  /** The selection to export. */
  readonly photoIds: readonly string[];
  readonly onClose: () => void;
}

type Phase = 'options' | 'running' | 'done';

interface Bar {
  readonly done: number;
  readonly total: number;
}

interface DestinationSelection {
  readonly path: string;
  readonly authorization: string;
}

export function ExportDialog({ open, photoIds, onClose }: ExportDialogProps): ReactElement | null {
  const { formatCount } = useFormats();
  const { announce } = useAnnouncer();
  const formatLabelId = useId();
  const destinationLabelId = useId();
  const [phase, setPhase] = useState<Phase>('options');
  const [format, setFormat] = useState<'original' | 'jpeg'>('original');
  const [decrypt, setDecrypt] = useState(true);
  const [destination, setDestination] = useState<DestinationSelection | null>(null);
  const [bar, setBar] = useState<Bar>({ done: 0, total: photoIds.length });
  const [exported, setExported] = useState(0);
  const [failed, setFailed] = useState(0);
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

  const start = (): void => {
    if (destination === null) {
      return;
    }
    setPhase('running');
    void window.overlook.export
      .run({ photoIds: [...photoIds], authorization: destination.authorization, format })
      .then((summary) => {
        setExported(summary.exported);
        setFailed(summary.failed);
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
              Export {formatCount(count)} {noun}
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
              {formatCount(count)} {noun} selected
            </div>
          </div>
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
          <div className="ovl-export__decrypt">
            <div>
              <div className="ovl-export__decryptTitle">Decrypt originals</div>
              <div className="ovl-export__decryptHint">
                Files are stored encrypted. Turn this on to write plain, openable files to disk.
              </div>
            </div>
            <Switch checked={decrypt} onChange={setDecrypt} label="Decrypt originals" />
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
                void window.overlook.export.pickDestination({}).then(({ path, authorization }) => {
                  if (path !== null && authorization !== null) {
                    setDestination({ path, authorization });
                  }
                });
              }}
            >
              {destination === null ? 'Choose folder…' : (destination.path.split('/').at(-1) ?? destination.path)}
            </Button>
          </div>
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
