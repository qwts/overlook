import { derivePlayability, type DeviceMediaCapabilities } from '../../../shared/library/playability.js';
import type { PhotoRecord } from '../../../shared/library/types.js';

// Per-device media capability probe (ADR-0026 §3). Playability is derived here
// at runtime from Chromium's decoders — never read from a stored flag. Probed
// once per codec per session and cached; the result never crosses into library
// rows, backup manifests, or interop payloads.

/** canPlayType probe strings per (container family, codec label). MP4 and
 * QuickTime share Chromium's BMFF demuxer and are served as video/mp4;
 * WebM probes as WebM. Codecs with NO entry (ProRes, MPEG-1/2, MPEG-4
 * Part 2, legacy AVI families) deliberately answer false — preserved-only
 * by derivation, not by a stored flag. A WebM verdict never vouches for the
 * same codec in MP4 or vice versa (PR #856 review). */
const BMFF_MIME: Readonly<Record<string, string>> = {
  'H.264': 'video/mp4; codecs="avc1.42E01E"',
  'H.265': 'video/mp4; codecs="hvc1.1.6.L93.B0"',
  AV1: 'video/mp4; codecs="av01.0.04M.08"',
  VP9: 'video/mp4; codecs="vp09.00.10.08"',
  AAC: 'audio/mp4; codecs="mp4a.40.2"',
  ALAC: 'audio/mp4; codecs="alac"',
  'AC-3': 'audio/mp4; codecs="ac-3"',
  'E-AC-3': 'audio/mp4; codecs="ec-3"',
  MP3: 'audio/mpeg',
  PCM: 'audio/wav; codecs="1"',
};

const WEBM_MIME: Readonly<Record<string, string>> = {
  VP8: 'video/webm; codecs="vp8"',
  VP9: 'video/webm; codecs="vp09.00.10.08"',
  AV1: 'video/webm; codecs="av01.0.04M.08"',
  Vorbis: 'audio/webm; codecs="vorbis"',
  Opus: 'audio/webm; codecs="opus"',
};

/** Remux-transport codecs (MPEG-TS → fMP4, #548) probe as BMFF. Containers
 * with no serving path never reach the codec probe — derivePlayability
 * refuses them first. */
function mimeFor(codec: string, container: string | undefined): string | undefined {
  if (container === 'WebM') return WEBM_MIME[codec];
  return BMFF_MIME[codec];
}

const decodeCache = new Map<string, boolean>();

function probeCodec(codec: string, container?: string): boolean {
  const key = `${container ?? 'BMFF'}:${codec}`;
  const cached = decodeCache.get(key);
  if (cached !== undefined) return cached;
  const mime = mimeFor(codec, container);
  let ok = false;
  if (mime !== undefined && typeof document !== 'undefined') {
    const el = document.createElement('video');
    if (typeof el.canPlayType === 'function') {
      const verdict = el.canPlayType(mime);
      ok = verdict === 'probably' || verdict === 'maybe';
    }
  }
  decodeCache.set(key, ok);
  return ok;
}

/**
 * True when this device can run the MPEG-TS → fragmented-MP4 remux path (§5):
 * MediaSource plus fMP4 decode for the v1 H.264 + AAC matrix. Kept import-light
 * (no mpegts.js import here) so the grid's tile derivation stays cheap; the
 * concrete adapter (ts-remux.ts) guards again before it attaches. The answer is
 * derived per device at runtime, never stored.
 */
export function transportStreamRemuxAvailable(): boolean {
  if (typeof window === 'undefined' || typeof window.MediaSource === 'undefined') return false;
  return window.MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
}

export function deviceMediaCapabilities(): DeviceMediaCapabilities {
  return {
    canDecodeCodec: probeCodec,
    transportStreamRemuxAvailable: transportStreamRemuxAvailable(),
  };
}

export interface VideoTileProps {
  readonly duration: number | null;
  readonly preserved: boolean;
  readonly placeholder: 'video' | 'audio' | 'probing';
}

/**
 * Grid-tile media props for a record, or null for stills. Video with an
 * incomplete probe shows the "probing" placeholder; audio shows the waveform
 * placeholder; otherwise the film placeholder plus a duration pill (poster
 * capture, when it lands, replaces the placeholder with the frame — the pill
 * and preserved wording are unchanged).
 */
export function videoTileProps(photo: PhotoRecord, caps: DeviceMediaCapabilities = deviceMediaCapabilities()): VideoTileProps | null {
  if (photo.fileKind === 'audio') return { duration: null, preserved: false, placeholder: 'audio' };
  if (photo.fileKind !== 'video') return null;
  const info = photo.mediaInfo;
  if (info === null || info.probeIncomplete === true) return { duration: null, preserved: false, placeholder: 'probing' };
  const preserved = derivePlayability('video', info, caps) === 'preserved-only';
  return { duration: info.durationSeconds ?? null, preserved, placeholder: 'video' };
}
