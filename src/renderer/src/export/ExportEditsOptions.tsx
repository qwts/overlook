import { useId, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { ExportPayloadMode } from '../../../shared/ipc/export-channels.js';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/Segmented';
import { Switch } from '../components/Switch';
import { useFormats } from '../i18n/use-formats.js';
import type { ExportPreflightReport } from './use-export-preflight.js';

// Edits control (#497, ADR-0031 §6): one declared payload mode — Bake, Original
// + XMP, Original only — with the explicit quality for Bake and the preflight
// loss report. Export stays disabled until the user continues with a named
// loss or picks another mode; Original only states what it omits.

const messages = defineMessages({
  label: { id: 'export.edits.label', defaultMessage: 'Edits' },
  bake: { id: 'export.edits.bake', defaultMessage: 'Bake' },
  originalXmp: { id: 'export.edits.originalXmp', defaultMessage: 'Original + XMP' },
  originalOnly: { id: 'export.edits.originalOnly', defaultMessage: 'Original only' },
  bakeHint: {
    id: 'export.edits.bakeHint',
    defaultMessage: 'Render the saved rotation, flip, and crop into a new JPEG. Embedded metadata is not carried over.',
  },
  originalXmpHint: {
    id: 'export.edits.originalXmpHint',
    defaultMessage: 'Write the byte-identical original beside an XMP sidecar that names the saved rotation, flip, and crop.',
  },
  originalOnlyHint: {
    id: 'export.edits.originalOnlyHint',
    defaultMessage: 'Write the byte-identical original and nothing beside it. Presentation edits and companion sidecars are omitted.',
  },
  quality: { id: 'export.edits.quality', defaultMessage: 'JPEG quality' },
  qualityBest: { id: 'export.edits.quality.best', defaultMessage: 'Best · 95' },
  qualityHigh: { id: 'export.edits.quality.high', defaultMessage: 'High · 90' },
  qualitySmall: { id: 'export.edits.quality.small', defaultMessage: 'Small · 80' },
  omitted: {
    id: 'export.edits.omitted',
    defaultMessage: '{count, plural, one {# photo has} other {# photos have}} presentation edits that will not be exported.',
  },
  losses: {
    id: 'export.edits.losses',
    defaultMessage: '{count, plural, one {# edit} other {# edits}} cannot travel in this mode:',
  },
  lossItem: { id: 'export.edits.lossItem', defaultMessage: '{fileName}: {reason}' },
  acknowledge: { id: 'export.edits.acknowledge', defaultMessage: 'Continue with these losses' },
});

export const EXPORT_JPEG_QUALITIES = { best: 95, high: 90, small: 80 } as const;
export type ExportJpegQuality = keyof typeof EXPORT_JPEG_QUALITIES;

export interface ExportEditsOptionsProps {
  readonly mode: ExportPayloadMode;
  readonly onModeChange: (mode: ExportPayloadMode) => void;
  readonly quality: ExportJpegQuality;
  readonly onQualityChange: (quality: ExportJpegQuality) => void;
  readonly disabled: boolean;
  /** Null while the preflight is loading or not applicable. */
  readonly preflight: ExportPreflightReport | null;
  readonly acknowledged: boolean;
  readonly onAcknowledge: (acknowledged: boolean) => void;
}

export function ExportEditsOptions({
  mode,
  onModeChange,
  quality,
  onQualityChange,
  disabled,
  preflight,
  acknowledged,
  onAcknowledge,
}: ExportEditsOptionsProps): ReactElement {
  const intl = useIntl();
  const { formatCount } = useFormats();
  const labelId = useId();
  const qualityId = useId();
  const losses = preflight?.losses ?? [];
  return (
    <>
      <div className="ovl-export__row" role="group" aria-labelledby={labelId}>
        <span id={labelId}>{intl.formatMessage(messages.label)}</span>
        <Segmented
          label={intl.formatMessage(messages.label)}
          value={disabled ? 'original' : mode}
          disabled={disabled}
          onChange={onModeChange}
          options={[
            { value: 'baked', label: intl.formatMessage(messages.bake) },
            { value: 'original-sidecars', label: intl.formatMessage(messages.originalXmp) },
            { value: 'original', label: intl.formatMessage(messages.originalOnly) },
          ]}
        />
      </div>
      {disabled ? null : (
        <div className="ovl-export__metadataHint" data-testid="export-edits-hint">
          {intl.formatMessage(
            mode === 'baked' ? messages.bakeHint : mode === 'original-sidecars' ? messages.originalXmpHint : messages.originalOnlyHint,
          )}
        </div>
      )}
      {disabled || mode !== 'baked' ? null : (
        <div className="ovl-export__row" role="group" aria-labelledby={qualityId}>
          <span id={qualityId}>{intl.formatMessage(messages.quality)}</span>
          <Segmented
            label={intl.formatMessage(messages.quality)}
            value={quality}
            onChange={onQualityChange}
            options={[
              { value: 'best', label: intl.formatMessage(messages.qualityBest) },
              { value: 'high', label: intl.formatMessage(messages.qualityHigh) },
              { value: 'small', label: intl.formatMessage(messages.qualitySmall) },
            ]}
          />
        </div>
      )}
      {disabled || preflight === null || mode !== 'original' || preflight.edited === 0 ? null : (
        <div className="ovl-export__photosNotice mono-data" data-testid="export-edits-omitted">
          <Icon name="info" size={12} />
          {intl.formatMessage(messages.omitted, { count: preflight.edited })}
        </div>
      )}
      {disabled || losses.length === 0 ? null : (
        <div className="ovl-export__losses" role="alert" data-testid="export-edits-losses">
          <div className="ovl-export__warning mono-data">
            <Icon name="triangle-alert" size={12} />
            {intl.formatMessage(messages.losses, { count: losses.length })}
          </div>
          <ul className="ovl-export__lossList mono-data">
            {losses.map((loss) => (
              <li key={loss.photoId}>{intl.formatMessage(messages.lossItem, { fileName: loss.fileName, reason: loss.reason })}</li>
            ))}
          </ul>
          <div className="ovl-export__acknowledge">
            <span>{formatCount(losses.length)}</span>
            <Switch checked={acknowledged} onChange={onAcknowledge} label={intl.formatMessage(messages.acknowledge)} />
          </div>
        </div>
      )}
    </>
  );
}
