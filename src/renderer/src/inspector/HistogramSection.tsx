import type { ReactElement } from 'react';
import { defineMessages, useIntl, type IntlShape } from 'react-intl';

import { MetadataRow } from '../components/MetadataRow';
import { previewFailureLabel } from '../components/previewFailureLabel';
import type { HistogramReady } from '../../../shared/ipc/histogram-channels.js';
import { HISTOGRAM_BINS, type HistogramChannels } from '../../../shared/library/histogram.js';
import type { PhotoRecord } from '../../../shared/library/types.js';
import { usePhotoHistogram, type HistogramView } from './use-photo-histogram';

// Inspector "Histogram" section (#498): red, green, blue and luminance bins
// over the photo's own mid derivative — sRGB, metadata-free, the persisted
// edit stack already baked in — drawn as one SVG on a shared square-root
// scale, with clipping named as a fraction of pixels at either end. The
// source row says what was measured so nobody mistakes it for sensor data.
// Missing, corrupt or failed derivatives say so; nothing is drawn from a
// fabricated source.

const messages = defineMessages({
  title: { id: 'inspector.histogram.title', defaultMessage: 'Histogram' },
  chart: { id: 'inspector.histogram.chart', defaultMessage: 'Histogram of {name}: red, green, blue and luminance' },
  computing: { id: 'inspector.histogram.computing', defaultMessage: 'Computing…' },
  state: { id: 'inspector.histogram.state', defaultMessage: 'State' },
  failed: { id: 'inspector.histogram.failed', defaultMessage: 'Histogram unavailable' },
  missing: { id: 'inspector.histogram.missing', defaultMessage: 'No preview in custody yet — repair pending' },
  corrupt: { id: 'inspector.histogram.corrupt', defaultMessage: 'Preview did not decode — repair pending' },
  clipping: { id: 'inspector.histogram.clipping', defaultMessage: 'Clipping' },
  clippingValue: { id: 'inspector.histogram.clippingValue', defaultMessage: 'Shadows {shadows} · Highlights {highlights}' },
  source: { id: 'inspector.histogram.source', defaultMessage: 'Source' },
  sourceValue: { id: 'inspector.histogram.sourceValue', defaultMessage: 'Preview · sRGB · {width}×{height}' },
});

const SECTION_CLASS = 'ovl-inspector__section';
const TITLE_CLASS = 'ovl-inspector__sectionTitle';
const NOTE_CLASS = 'ovl-inspector__histogramNote';
const CHART_CLASS = 'ovl-inspector__histogram';
const CHANNEL_CLASS = 'ovl-inspector__histogramChannel';
const LUMA_CLASS = 'ovl-inspector__histogramLuma';
const TEST_ID = 'inspector-histogram';
const CHART_HEIGHT = 64;
/** Clipping at or above this share of pixels is called out in amber. */
const CLIPPING_TONE_THRESHOLD = 0.01;
const CLIPPING_TONE = 'var(--accent-amber)';

function channelPath(bins: readonly number[], peak: number, closed: boolean): string {
  const points = bins.map((count, index) => {
    const y = peak === 0 ? CHART_HEIGHT : CHART_HEIGHT - CHART_HEIGHT * Math.sqrt(count / peak);
    return `${index === 0 ? 'M' : 'L'}${String(index)},${y.toFixed(2)}`;
  });
  return closed
    ? `M0,${String(CHART_HEIGHT)} ${points.join(' ').replace(/^M/u, 'L')} L${String(HISTOGRAM_BINS - 1)},${String(CHART_HEIGHT)} Z`
    : points.join(' ');
}

function Chart({ channels, label }: { readonly channels: HistogramChannels; readonly label: string }): ReactElement {
  const peak = Math.max(...channels.red, ...channels.green, ...channels.blue, ...channels.luma);
  return (
    <svg
      className={CHART_CLASS}
      viewBox={`0 0 ${String(HISTOGRAM_BINS)} ${String(CHART_HEIGHT)}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <path className={`${CHANNEL_CLASS} ${CHANNEL_CLASS}--red`} d={channelPath(channels.red, peak, true)} />
      <path className={`${CHANNEL_CLASS} ${CHANNEL_CLASS}--green`} d={channelPath(channels.green, peak, true)} />
      <path className={`${CHANNEL_CLASS} ${CHANNEL_CLASS}--blue`} d={channelPath(channels.blue, peak, true)} />
      <path className={LUMA_CLASS} d={channelPath(channels.luma, peak, false)} />
    </svg>
  );
}

function Ready({
  intl,
  photo,
  payload,
}: {
  readonly intl: IntlShape;
  readonly photo: PhotoRecord;
  readonly payload: HistogramReady;
}): ReactElement {
  const shadows = Math.max(payload.clipping.shadows.red, payload.clipping.shadows.green, payload.clipping.shadows.blue);
  const highlights = Math.max(payload.clipping.highlights.red, payload.clipping.highlights.green, payload.clipping.highlights.blue);
  const percent = (value: number): string => intl.formatNumber(value, { style: 'percent', maximumFractionDigits: 1 });
  const clipped = Math.max(shadows, highlights) >= CLIPPING_TONE_THRESHOLD;
  return (
    <>
      <Chart channels={payload.channels} label={intl.formatMessage(messages.chart, { name: photo.fileName })} />
      <MetadataRow
        label={intl.formatMessage(messages.clipping)}
        value={intl.formatMessage(messages.clippingValue, { shadows: percent(shadows), highlights: percent(highlights) })}
        {...(clipped ? { tone: CLIPPING_TONE } : {})}
      />
      <MetadataRow
        label={intl.formatMessage(messages.source)}
        value={intl.formatMessage(messages.sourceValue, { width: String(payload.width), height: String(payload.height) })}
      />
    </>
  );
}

function unavailableCopy(intl: IntlShape, photo: PhotoRecord, view: HistogramView): string {
  if (view.status === 'unavailable') {
    if (view.payload.reason === 'preview-failure') return previewFailureLabel(intl, photo.previewFailure);
    if (view.payload.reason === 'corrupt') return intl.formatMessage(messages.corrupt);
    return intl.formatMessage(messages.missing);
  }
  return intl.formatMessage(messages.failed);
}

export function HistogramSection({ photo }: { readonly photo: PhotoRecord }): ReactElement | null {
  const intl = useIntl();
  const histogram = usePhotoHistogram(photo.id);
  if (!histogram.available) return null;
  const { view } = histogram;
  const ready = view.status === 'ready' ? view.payload : null;
  const state = view.status === 'ready' ? 'ready' : view.status === 'computing' ? 'computing' : 'unavailable';
  return (
    <section
      className={SECTION_CLASS}
      data-testid={TEST_ID}
      data-state={state}
      data-digest={ready?.digest ?? ''}
      data-size={ready === null ? '' : `${String(ready.width)}×${String(ready.height)}`}
      data-revision={ready?.revisionId ?? ''}
    >
      <h3 className={TITLE_CLASS}>{intl.formatMessage(messages.title)}</h3>
      {ready !== null ? (
        <Ready intl={intl} photo={photo} payload={ready} />
      ) : view.status === 'computing' ? (
        <p className={NOTE_CLASS}>{intl.formatMessage(messages.computing)}</p>
      ) : (
        <MetadataRow label={intl.formatMessage(messages.state)} value={unavailableCopy(intl, photo, view)} tone={CLIPPING_TONE} />
      )}
    </section>
  );
}
