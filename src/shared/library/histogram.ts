// Image histogram (#498): RGB and luminance bins over 8-bit sRGB-encoded
// samples plus per-channel clipping fractions. Pure — it runs inside the
// main process's histogram worker and is unit-tested with synthetic pixels.
// The input is a photo's own mid derivative (ADR-0006: sRGB, metadata-free,
// the persisted edit stack already baked in), so the shape describes what
// the lightbox shows rather than the sensor, and no metadata is read to
// produce it.

export const HISTOGRAM_BINS = 256;

export interface HistogramChannels {
  readonly red: readonly number[];
  readonly green: readonly number[];
  readonly blue: readonly number[];
  /** Rec. 709 luma over the encoded values: 0.2126 R + 0.7152 G + 0.0722 B. */
  readonly luma: readonly number[];
}

export interface ChannelFractions {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

export interface HistogramClipping {
  /** Fraction of pixels at 0 in each channel. */
  readonly shadows: ChannelFractions;
  /** Fraction of pixels at 255 in each channel. */
  readonly highlights: ChannelFractions;
}

export interface HistogramData {
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
  readonly channels: HistogramChannels;
  readonly clipping: HistogramClipping;
}

function bump(bins: Uint32Array, value: number): void {
  bins[value] = (bins[value] ?? 0) + 1;
}

/**
 * Bins interleaved 8-bit samples. One or two channels per pixel is grey (plus
 * alpha); three or four is RGB (plus alpha, which is ignored). Luma is rounded
 * to the nearest bin from the encoded values — a display-referred histogram,
 * as photo tools draw it, not a linear-light one.
 */
export function binHistogram(samples: Uint8Array, width: number, height: number, channelsPerPixel: number): HistogramData {
  if (!Number.isInteger(channelsPerPixel) || channelsPerPixel < 1 || channelsPerPixel > 4) {
    throw new RangeError(`unsupported channel count ${String(channelsPerPixel)}`);
  }
  const pixels = width * height;
  if (samples.length < pixels * channelsPerPixel) {
    throw new RangeError('sample buffer is shorter than width × height × channels');
  }
  const red = new Uint32Array(HISTOGRAM_BINS);
  const green = new Uint32Array(HISTOGRAM_BINS);
  const blue = new Uint32Array(HISTOGRAM_BINS);
  const luma = new Uint32Array(HISTOGRAM_BINS);
  if (channelsPerPixel < 3) {
    for (let offset = 0; offset < pixels * channelsPerPixel; offset += channelsPerPixel) {
      const value = samples[offset] ?? 0;
      bump(red, value);
    }
    green.set(red);
    blue.set(red);
    luma.set(red);
  } else {
    for (let offset = 0; offset < pixels * channelsPerPixel; offset += channelsPerPixel) {
      const r = samples[offset] ?? 0;
      const g = samples[offset + 1] ?? 0;
      const b = samples[offset + 2] ?? 0;
      bump(red, r);
      bump(green, g);
      bump(blue, b);
      bump(luma, Math.min(HISTOGRAM_BINS - 1, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)));
    }
  }
  const fraction = (count: number | undefined): number => (pixels === 0 ? 0 : (count ?? 0) / pixels);
  const edge = (index: number): ChannelFractions => ({
    red: fraction(red[index]),
    green: fraction(green[index]),
    blue: fraction(blue[index]),
  });
  return {
    width,
    height,
    pixels,
    channels: { red: Array.from(red), green: Array.from(green), blue: Array.from(blue), luma: Array.from(luma) },
    clipping: { shadows: edge(0), highlights: edge(HISTOGRAM_BINS - 1) },
  };
}

/** A short, stable fingerprint of the bins (FNV-1a over the counts), so a
 * test can tell "the histogram changed" without comparing 1024 numbers. */
export function histogramDigest(channels: HistogramChannels): string {
  let hash = 0x811c9dc5;
  const mix = (byte: number): void => {
    hash ^= byte & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  for (const bins of [channels.red, channels.green, channels.blue, channels.luma]) {
    for (const count of bins) {
      mix(count);
      mix(count >>> 8);
      mix(count >>> 16);
      mix(count >>> 24);
    }
  }
  return hash.toString(16).padStart(8, '0');
}
