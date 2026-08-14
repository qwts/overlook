import { useEffect, useId, useState, type ChangeEvent, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { Board } from '../../../shared/moodboard/board.js';
import type { PlacementAvailability } from '../../../shared/moodboard/availability.js';
import type { BoardExportColorSpace, BoardExportResult } from '../../../shared/moodboard/export-contract.js';
import { Button } from '../components/Button';
import { CopyableValue } from '../components/CopyableValue';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { ProgressBar } from '../components/ProgressBar';
import { Segmented } from '../components/Segmented';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { useFormats } from '../i18n/use-formats.js';

import './export.css';

const messages = defineMessages({
  title: { id: 'moodboard.export.title', defaultMessage: 'Export board' },
  dimensions: { id: 'moodboard.export.dimensions', defaultMessage: 'Output dimensions' },
  width: { id: 'moodboard.export.width', defaultMessage: 'Width' },
  height: { id: 'moodboard.export.height', defaultMessage: 'Height' },
  dimensionSeparator: { id: 'moodboard.export.dimensionSeparator', defaultMessage: '×' },
  pixels: { id: 'moodboard.export.pixels', defaultMessage: 'pixels' },
  colorSpace: { id: 'moodboard.export.colorSpace', defaultMessage: 'Color space' },
  srgb: { id: 'moodboard.export.colorSpace.srgb', defaultMessage: 'sRGB' },
  p3: { id: 'moodboard.export.colorSpace.p3', defaultMessage: 'Display P3' },
  destination: { id: 'moodboard.export.destination', defaultMessage: 'Destination' },
  chooseFolder: { id: 'moodboard.export.chooseFolder', defaultMessage: 'Choose folder…' },
  cancel: { id: 'moodboard.export.cancel', defaultMessage: 'Cancel' },
  done: { id: 'moodboard.export.done', defaultMessage: 'Done' },
  export: { id: 'moodboard.export.action', defaultMessage: 'Export board' },
  composing: { id: 'moodboard.export.composing', defaultMessage: 'Composing board' },
  invalidSize: { id: 'moodboard.export.invalidSize', defaultMessage: 'Choose dimensions up to 8,192 pixels and 32 megapixels.' },
  failed: { id: 'moodboard.export.failed', defaultMessage: 'Board export failed. No source photos were changed.' },
  cancelled: { id: 'moodboard.export.cancelled', defaultMessage: 'Board export canceled.' },
  complete: {
    id: 'moodboard.export.complete',
    defaultMessage: 'Board exported with {rendered} {rendered, plural, one {placement} other {placements}}.',
  },
  skipped: {
    id: 'moodboard.export.skipped',
    defaultMessage: '{count} locked or unavailable {count, plural, one {placement was} other {placements were}} skipped.',
  },
  outputPath: { id: 'moodboard.export.outputPath', defaultMessage: 'board export path' },
});

type Phase = 'options' | 'running' | 'done';

interface DestinationSelection {
  readonly path: string;
  readonly authorization: string;
}

export interface BoardExportDialogProps {
  readonly board: Board;
  readonly availability: Readonly<Record<string, PlacementAvailability>>;
  readonly onClose: () => void;
}

function parsedDimension(event: ChangeEvent<HTMLInputElement>): number {
  return Number.parseInt(event.target.value, 10) || 0;
}

export function BoardExportDialog({ board, availability, onClose }: BoardExportDialogProps): ReactElement {
  const intl = useIntl();
  const { announce } = useAnnouncer();
  const { formatCount } = useFormats();
  const dimensionsId = useId();
  const [width, setWidth] = useState(board.size.width);
  const [height, setHeight] = useState(board.size.height);
  const [colorSpace, setColorSpace] = useState<BoardExportColorSpace>('srgb');
  const [destination, setDestination] = useState<DestinationSelection | null>(null);
  const [phase, setPhase] = useState<Phase>('options');
  const [progress, setProgress] = useState({ done: 0, total: board.placements.length });
  const [result, setResult] = useState<BoardExportResult | null>(null);
  const [failed, setFailed] = useState(false);
  const validSize = width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 32 * 1024 * 1024;
  const request = { board, availability: { ...availability }, output: { width, height }, colorSpace };

  useEffect(() => {
    if (phase !== 'running') return;
    return window.overlook.export.onProgress(setProgress);
  }, [phase]);

  const discardDestination = (): void => {
    if (destination !== null) {
      void window.overlook.export.revokeDestination({ authorization: destination.authorization });
      setDestination(null);
    }
  };

  const close = (): void => {
    discardDestination();
    onClose();
  };

  const start = (): void => {
    if (destination === null || !validSize) return;
    setPhase('running');
    void window.overlook.export
      .runBoard({ ...request, authorization: destination.authorization })
      .then((next) => {
        setResult(next);
        setPhase('done');
        if (next.cancelled) announce(intl.formatMessage(messages.cancelled), 'polite');
        else announce(intl.formatMessage(messages.complete, { rendered: next.rendered }), 'polite');
      })
      .catch(() => {
        setFailed(true);
        setDestination(null);
        setPhase('options');
        announce(intl.formatMessage(messages.failed), 'assertive');
      });
  };

  const skipped = result?.skipped ?? 0;
  return (
    <Dialog
      open
      title={intl.formatMessage(messages.title)}
      icon="share"
      width={420}
      onClose={phase === 'running' ? undefined : close}
      footer={
        phase === 'options' ? (
          <>
            <Button variant="ghost" onClick={close}>
              {intl.formatMessage(messages.cancel)}
            </Button>
            <Button variant="primary" icon="share" disabled={destination === null || !validSize} onClick={start}>
              {intl.formatMessage(messages.export)}
            </Button>
          </>
        ) : phase === 'running' ? (
          <Button variant="ghost" onClick={() => void window.overlook.export.cancel({})}>
            {intl.formatMessage(messages.cancel)}
          </Button>
        ) : (
          <Button variant="primary" onClick={close}>
            {intl.formatMessage(messages.done)}
          </Button>
        )
      }
    >
      {phase === 'options' ? (
        <div className="ovl-export__options">
          <div className="ovl-export__card">
            <Icon name="layout-grid" size={16} />
            <div className="ovl-export__cardTitle">{board.title}</div>
          </div>
          <div className="ovl-export__dimensionGroup" role="group" aria-labelledby={dimensionsId}>
            <span id={dimensionsId}>{intl.formatMessage(messages.dimensions)}</span>
            <label>
              <span>{intl.formatMessage(messages.width)}</span>
              <input
                className="mono-data"
                type="number"
                min={1}
                max={8192}
                value={width}
                onChange={(event) => {
                  discardDestination();
                  setWidth(parsedDimension(event));
                }}
              />
            </label>
            <span aria-hidden="true">{intl.formatMessage(messages.dimensionSeparator)}</span>
            <label>
              <span>{intl.formatMessage(messages.height)}</span>
              <input
                className="mono-data"
                type="number"
                min={1}
                max={8192}
                value={height}
                onChange={(event) => {
                  discardDestination();
                  setHeight(parsedDimension(event));
                }}
              />
            </label>
            <span>{intl.formatMessage(messages.pixels)}</span>
          </div>
          {validSize ? null : (
            <div className="ovl-export__warning" role="alert">
              <Icon name="triangle-alert" size={12} />
              {intl.formatMessage(messages.invalidSize)}
            </div>
          )}
          <div className="ovl-export__row">
            <span>{intl.formatMessage(messages.colorSpace)}</span>
            <Segmented
              label={intl.formatMessage(messages.colorSpace)}
              value={colorSpace}
              onChange={(next) => {
                if (next !== colorSpace) discardDestination();
                setColorSpace(next);
              }}
              options={[
                { value: 'srgb', label: intl.formatMessage(messages.srgb) },
                { value: 'display-p3', label: intl.formatMessage(messages.p3) },
              ]}
            />
          </div>
          <div className="ovl-export__row">
            <span>{intl.formatMessage(messages.destination)}</span>
            <Button
              variant="secondary"
              icon="folder"
              size="sm"
              onClick={() => {
                void window.overlook.export.pickDestination({ intent: { operation: 'board', request } }).then(({ path, authorization }) => {
                  if (path !== null && authorization !== null) {
                    setFailed(false);
                    setDestination({ path, authorization });
                  }
                });
              }}
            >
              {destination === null ? intl.formatMessage(messages.chooseFolder) : (destination.path.split('/').at(-1) ?? destination.path)}
            </Button>
          </div>
          {destination === null ? null : (
            <CopyableValue
              value={destination.path}
              label={intl.formatMessage(messages.destination)}
              className="ovl-export__destinationPath"
            />
          )}
          {failed ? (
            <div className="ovl-export__failed" role="alert">
              <Icon name="triangle-alert" size={15} />
              {intl.formatMessage(messages.failed)}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="ovl-export__running">
          <ProgressBar
            label={intl.formatMessage(messages.composing)}
            tone="cyan"
            value={progress.done}
            max={Math.max(progress.total, 1)}
            detail={`${formatCount(progress.done)} / ${formatCount(progress.total)}`}
          />
          {phase !== 'done' ? null : failed ? (
            <div className="ovl-export__failed" role="alert">
              <Icon name="triangle-alert" size={15} />
              {intl.formatMessage(messages.failed)}
            </div>
          ) : result?.cancelled === true ? (
            <div className="ovl-export__warning" role="status">
              <Icon name="info" size={15} />
              {intl.formatMessage(messages.cancelled)}
            </div>
          ) : result === null ? null : (
            <div className="ovl-export__result">
              <div className="ovl-export__done">
                <Icon name="circle-check" size={15} />
                {intl.formatMessage(messages.complete, { rendered: result.rendered })}
              </div>
              {skipped === 0 ? null : (
                <div className="ovl-export__warning" role="status">
                  <Icon name="triangle-alert" size={12} />
                  {intl.formatMessage(messages.skipped, { count: skipped })}
                </div>
              )}
              {result.path === null ? null : (
                <CopyableValue
                  value={result.path}
                  label={intl.formatMessage(messages.outputPath)}
                  className="ovl-export__destinationPath"
                />
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
