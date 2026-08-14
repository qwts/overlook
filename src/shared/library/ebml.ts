import type { MediaInfo, MediaStream } from './media-info.js';

// EBML / Matroska / WebM signature + bounded probe per ADR-0026 §2/§9 (#549).
// Pure byte inspection. The DocType decides WebM vs Matroska; Matroska is
// provisional (preserved-only) per the issue's gate, so the probe records
// facts identically for both and the playability derivation refuses MKV.

const EBML_MAGIC = 0x1a45dfa3;

/** Probe bounds (§9). */
const MAX_ELEMENTS = 512;
const MAX_TRACKS = 32;

const ID_DOCTYPE = 0x4282;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC = 0x86;
const ID_VIDEO = 0xe0;
const ID_AUDIO_EL = 0xe1;
const ID_PIXEL_WIDTH = 0xb0;
const ID_PIXEL_HEIGHT = 0xba;

/** Matroska codec IDs → human labels; unknown IDs stay preserved streams
 * with a null codec (§4). */
const CODEC_LABELS: Readonly<Record<string, string>> = {
  V_VP8: 'VP8',
  V_VP9: 'VP9',
  V_AV1: 'AV1',
  'V_MPEG4/ISO/AVC': 'H.264',
  'V_MPEGH/ISO/HEVC': 'H.265',
  'V_MPEG4/ISO/ASP': 'MPEG-4 Part 2',
  V_THEORA: 'Theora',
  A_VORBIS: 'Vorbis',
  A_OPUS: 'Opus',
  'A_AAC/MPEG4/LC': 'AAC',
  A_AAC: 'AAC',
  'A_MPEG/L3': 'MP3',
  'A_MPEG/L2': 'MP2',
  A_AC3: 'AC-3',
  A_EAC3: 'E-AC-3',
  A_FLAC: 'FLAC',
  'A_PCM/INT/LIT': 'PCM',
};

interface Element {
  readonly id: number;
  readonly start: number;
  readonly end: number;
}

/** EBML variable-length integer at `at`: [value, bytesRead] or null. When
 * `keepMask` is true the length-descriptor bit stays (element IDs); vint
 * data values strip it. */
function vint(bytes: Uint8Array, at: number, keepMask: boolean): readonly [number, number] | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  for (let mask = 0x80; (first & mask) === 0; mask >>= 1) {
    length += 1;
    if (length > 8) return null;
  }
  if (at + length > bytes.length) return null;
  let value = keepMask ? first : first & (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + (bytes[at + i] ?? 0);
  }
  return [value, length];
}

function* elements(bytes: Uint8Array, start: number, end: number, budget: { elements: number }): Generator<Element> {
  let at = start;
  while (at < end) {
    if (budget.elements <= 0) return;
    budget.elements -= 1;
    const id = vint(bytes, at, true);
    if (id === null) return;
    const size = vint(bytes, at + id[1], false);
    if (size === null) return;
    const payload = at + id[1] + size[1];
    // An "unknown size" vint (all value bits set) extends to scope end.
    const knownEnd = payload + size[0];
    const elementEnd = knownEnd > end || size[0] >= Number.MAX_SAFE_INTEGER ? end : knownEnd;
    if (payload > end) return;
    yield { id: id[0], start: payload, end: elementEnd };
    at = elementEnd;
  }
}

function findElement(bytes: Uint8Array, start: number, end: number, id: number, budget: { elements: number }): Element | null {
  for (const element of elements(bytes, start, end, budget)) {
    if (element.id === id) return element;
  }
  return null;
}

function uintValue(bytes: Uint8Array, element: Element): number {
  let value = 0;
  for (let at = element.start; at < element.end && at - element.start < 8; at++) {
    value = value * 256 + (bytes[at] ?? 0);
  }
  return value;
}

function floatValue(bytes: Uint8Array, element: Element): number | null {
  const length = element.end - element.start;
  const view = new DataView(bytes.buffer, bytes.byteOffset + element.start, Math.min(length, 8));
  if (length === 4) return view.getFloat32(0);
  if (length === 8) return view.getFloat64(0);
  return null;
}

function stringValue(bytes: Uint8Array, element: Element): string {
  let out = '';
  for (let at = element.start; at < element.end && at - element.start < 64; at++) {
    const byte = bytes[at] ?? 0;
    if (byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

export type EbmlKind = 'WebM' | 'Matroska';

/** Signature-first classification: the EBML magic plus a DocType of webm or
 * matroska. Anything else EBML-shaped is not our media. */
export function detectEbml(bytes: Uint8Array): EbmlKind | null {
  if (bytes.length < 8) return null;
  if ((((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)) >>> 0 !== EBML_MAGIC) return null;
  const budget = { elements: 64 };
  const header = vint(bytes, 4, false);
  if (header === null) return null;
  const headerEnd = Math.min(4 + header[1] + header[0], bytes.length);
  const doctype = findElement(bytes, 4 + header[1], headerEnd, ID_DOCTYPE, budget);
  if (doctype === null) return null;
  const value = stringValue(bytes, doctype);
  if (value === 'webm') return 'WebM';
  if (value === 'matroska') return 'Matroska';
  return null;
}

/** Bounded facts probe for a detected EBML movie (§2/§9). */
export function probeEbml(bytes: Uint8Array): MediaInfo | null {
  const kind = detectEbml(bytes);
  if (kind === null) return null;
  const budget = { elements: MAX_ELEMENTS };

  const streams: MediaStream[] = [];
  let durationSeconds: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let incomplete = true;

  const header = vint(bytes, 4, false);
  const afterHeader = header === null ? 4 : 4 + header[1] + header[0];
  const segment = findElement(bytes, afterHeader, bytes.length, ID_SEGMENT, budget);
  if (segment !== null) {
    const infoElement = findElement(bytes, segment.start, segment.end, ID_INFO, budget);
    if (infoElement !== null) {
      const scale = findElement(bytes, infoElement.start, infoElement.end, ID_TIMECODE_SCALE, budget);
      const duration = findElement(bytes, infoElement.start, infoElement.end, ID_DURATION, budget);
      const timecodeScale = scale === null ? 1_000_000 : uintValue(bytes, scale);
      const raw = duration === null ? null : floatValue(bytes, duration);
      if (raw !== null && raw > 0) durationSeconds = Math.round(raw * (timecodeScale / 1e9) * 1000) / 1000;
    }
    const tracks = findElement(bytes, segment.start, segment.end, ID_TRACKS, budget);
    if (tracks !== null) {
      incomplete = false;
      let seen = 0;
      for (const entry of elements(bytes, tracks.start, tracks.end, budget)) {
        if (entry.id !== ID_TRACK_ENTRY) continue;
        if (seen >= MAX_TRACKS) {
          incomplete = true;
          break;
        }
        seen += 1;
        const trackType = findElement(bytes, entry.start, entry.end, ID_TRACK_TYPE, budget);
        const codecId = findElement(bytes, entry.start, entry.end, ID_CODEC, budget);
        const type =
          trackType === null ? null : uintValue(bytes, trackType) === 1 ? 'video' : uintValue(bytes, trackType) === 2 ? 'audio' : null;
        if (type === null) continue;
        const codec = codecId === null ? null : (CODEC_LABELS[stringValue(bytes, codecId)] ?? null);
        streams.push({ type, codec, profile: null });
        if (type === 'video' && width === null) {
          const video =
            findElement(bytes, entry.start, entry.end, ID_VIDEO, budget) ?? findElement(bytes, entry.start, entry.end, ID_AUDIO_EL, budget);
          if (video !== null) {
            const w = findElement(bytes, video.start, video.end, ID_PIXEL_WIDTH, budget);
            const h = findElement(bytes, video.start, video.end, ID_PIXEL_HEIGHT, budget);
            width = w === null ? null : uintValue(bytes, w) || null;
            height = h === null ? null : uintValue(bytes, h) || null;
          }
        }
      }
    }
    if (budget.elements <= 0) incomplete = true;
  }

  return {
    animated: false,
    frameCount: null,
    loopCount: null,
    container: kind,
    streams,
    durationSeconds,
    codedWidth: width,
    codedHeight: height,
    displayWidth: width,
    displayHeight: height,
    rotationDegrees: null,
    frameRate: null,
    variableFrameRate: false,
    audioPresent: streams.some((stream) => stream.type === 'audio'),
    hdr: null,
    colorTransfer: null,
    ...(incomplete ? { probeIncomplete: true } : {}),
  };
}
