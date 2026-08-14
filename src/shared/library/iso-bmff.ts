import type { MediaInfo, MediaStream } from './media-info.js';

// ISO Base Media File Format / QuickTime (ISO/IEC 14496-12) signature +
// bounded moov probe per ADR-0026 §2/§9 (#549). Pure, dependency-free byte
// inspection: no demuxer, no decoder. Covers the Apple/iPhone outputs the
// issue names — H.264/HEVC MOV+MP4, ProRes MOV — plus M4V. Everything is
// bounded: a hostile or truncated file degrades to `probeIncomplete`, never
// a crawl or a throw. Still-image ftyp brands (HEIC/AVIF) are rejected here;
// the still sniffer owns them and wins first at the engine anyway.

/** Probe bounds (§9): boxes visited across the whole walk and tracks read. */
const MAX_BOXES = 512;
const MAX_TRACKS = 32;

const IMAGE_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis']);
const QUICKTIME_BRANDS = new Set(['qt  ']);

/** Sample-entry fourcc → human codec label. Unknown fourccs are preserved
 * streams with a null codec — counted, never dropped (§4). */
const VIDEO_CODECS: Readonly<Record<string, string>> = {
  avc1: 'H.264',
  avc3: 'H.264',
  hvc1: 'H.265',
  hev1: 'H.265',
  mp4v: 'MPEG-4 Part 2',
  vp09: 'VP9',
  av01: 'AV1',
  apco: 'ProRes',
  apcs: 'ProRes',
  apcn: 'ProRes',
  apch: 'ProRes',
  ap4h: 'ProRes',
  ap4x: 'ProRes',
  jpeg: 'MJPEG',
};

const AUDIO_CODECS: Readonly<Record<string, string>> = {
  mp4a: 'AAC',
  alac: 'ALAC',
  sowt: 'PCM',
  twos: 'PCM',
  lpcm: 'PCM',
  'ac-3': 'AC-3',
  'ec-3': 'E-AC-3',
  '.mp3': 'MP3',
  opus: 'Opus',
};

interface Box {
  readonly type: string;
  readonly start: number; // payload start
  readonly end: number; // payload end (exclusive)
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = '';
  for (let i = at; i < at + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
}

function u64(bytes: Uint8Array, at: number): number {
  // Safe up to 2^53 — box sizes/durations beyond that are hostile anyway.
  return u32(bytes, at) * 0x1_0000_0000 + (u32(bytes, at + 4) >>> 0);
}

/** Walks the sibling boxes of one container payload, bounded. Returns null
 * (aborting the caller's iteration) once the box budget is spent. */
function* boxes(bytes: Uint8Array, start: number, end: number, budget: { boxes: number }): Generator<Box> {
  let at = start;
  while (at + 8 <= end) {
    if (budget.boxes <= 0) return;
    budget.boxes -= 1;
    let size = u32(bytes, at) >>> 0;
    const type = ascii(bytes, at + 4, 4);
    let payload = at + 8;
    if (size === 1) {
      if (at + 16 > end) return;
      size = u64(bytes, at + 8);
      payload = at + 16;
    } else if (size === 0) {
      size = end - at; // box extends to end of enclosing scope
    }
    if (size < payload - at || at + size > end) return; // torn/hostile
    yield { type, start: payload, end: at + size };
    at += size;
  }
}

function findBox(bytes: Uint8Array, start: number, end: number, type: string, budget: { boxes: number }): Box | null {
  for (const box of boxes(bytes, start, end, budget)) {
    if (box.type === type) return box;
  }
  return null;
}

export type IsoBmffKind = 'MP4' | 'QuickTime';

/** Signature-first classification (ADR-0026 §2): a leading `ftyp` whose brand
 * is a movie brand. Still-image brands return null — they are the still
 * sniffer's business. Names never decide. */
export function detectIsoBmff(bytes: Uint8Array): IsoBmffKind | null {
  if (bytes.length < 12 || ascii(bytes, 4, 4) !== 'ftyp') return null;
  const size = u32(bytes, 0) >>> 0;
  if (size < 12 || size % 4 !== 0) return null;
  const major = ascii(bytes, 8, 4);
  if (IMAGE_BRANDS.has(major.toLowerCase())) {
    return null;
  }
  if (QUICKTIME_BRANDS.has(major)) return 'QuickTime';
  // Compatible brands can carry qt even under an unfamiliar major.
  const compatEnd = Math.min(size, bytes.length, 64);
  for (let at = 16; at + 4 <= compatEnd; at += 4) {
    if (QUICKTIME_BRANDS.has(ascii(bytes, at, 4))) return 'QuickTime';
  }
  return 'MP4';
}

/** tkhd matrix → display rotation. The matrix is 9 32-bit fixed-point values;
 * the four canonical rotations are recognized, anything else records null. */
function rotationFromMatrix(bytes: Uint8Array, at: number): 0 | 90 | 180 | 270 | null {
  const a = u32(bytes, at) | 0;
  const b = u32(bytes, at + 4) | 0;
  const c = u32(bytes, at + 12) | 0;
  const d = u32(bytes, at + 16) | 0;
  const ONE = 0x0001_0000;
  if (a === ONE && b === 0 && c === 0 && d === ONE) return 0;
  if (a === 0 && b === ONE && c === -ONE && d === 0) return 90;
  if (a === -ONE && b === 0 && c === 0 && d === -ONE) return 180;
  if (a === 0 && b === -ONE && c === ONE && d === 0) return 270;
  return null;
}

interface TrackFacts {
  readonly stream: MediaStream;
  readonly width: number | null;
  readonly height: number | null;
  readonly rotation: 0 | 90 | 180 | 270 | null;
  readonly frameRate: number | null;
  readonly variableFrameRate: boolean;
  readonly hdr: boolean | null;
  readonly colorTransfer: string | null;
}

function probeTrack(bytes: Uint8Array, trak: Box, budget: { boxes: number }): TrackFacts | null {
  const mdia = findBox(bytes, trak.start, trak.end, 'mdia', budget);
  if (mdia === null) return null;
  const hdlr = findBox(bytes, mdia.start, mdia.end, 'hdlr', budget);
  if (hdlr === null) return null;
  const handler = ascii(bytes, hdlr.start + 8, 4);
  const type = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : null;
  if (type === null) return null;

  // tkhd: version(1)+flags(3), times, id — matrix at v0 offset 40, v1 52;
  // track width/height (16.16) trail the matrix.
  let width: number | null = null;
  let height: number | null = null;
  let rotation: TrackFacts['rotation'] = null;
  const tkhd = findBox(bytes, trak.start, trak.end, 'tkhd', budget);
  if (tkhd !== null) {
    const version = bytes[tkhd.start] ?? 0;
    const matrixAt = tkhd.start + (version === 1 ? 52 : 40);
    if (matrixAt + 36 + 8 <= tkhd.end) {
      rotation = rotationFromMatrix(bytes, matrixAt);
      const w = u32(bytes, matrixAt + 36) >>> 16;
      const h = u32(bytes, matrixAt + 40) >>> 16;
      width = w > 0 ? w : null;
      height = h > 0 ? h : null;
    }
  }

  // mdhd for the media timescale (frame-rate derivation).
  let timescale = 0;
  const mdhd = findBox(bytes, mdia.start, mdia.end, 'mdhd', budget);
  if (mdhd !== null) {
    const version = bytes[mdhd.start] ?? 0;
    timescale = version === 1 ? u32(bytes, mdhd.start + 20) >>> 0 : u32(bytes, mdhd.start + 12) >>> 0;
  }

  const minf = findBox(bytes, mdia.start, mdia.end, 'minf', budget);
  const stbl = minf === null ? null : findBox(bytes, minf.start, minf.end, 'stbl', budget);
  let codec: string | null = null;
  let hdr: boolean | null = null;
  let colorTransfer: string | null = null;
  let frameRate: number | null = null;
  let variableFrameRate = false;
  if (stbl !== null) {
    const stsd = findBox(bytes, stbl.start, stbl.end, 'stsd', budget);
    if (stsd !== null && stsd.start + 16 <= stsd.end) {
      // stsd payload: version+flags (4), entry count (4), then the first
      // sample-entry box — size (4) + fourcc (4) + fixed fields.
      const fourcc = ascii(bytes, stsd.start + 12, 4);
      codec = (type === 'video' ? VIDEO_CODECS[fourcc] : AUDIO_CODECS[fourcc]) ?? null;
      if (type === 'video') {
        const entrySize = u32(bytes, stsd.start + 8) >>> 0;
        const entryPayload = stsd.start + 16;
        const entryEnd = Math.min(stsd.start + 8 + entrySize, stsd.end);
        // Video sample entry: 78 fixed bytes after the size+fourcc header
        // precede child boxes; colr (nclx) there names the transfer —
        // PQ(16)/HLG(18) mean HDR (§1 color metadata, never re-encoded).
        const childrenAt = entryPayload + 78;
        if (childrenAt < entryEnd) {
          const colr = findBox(bytes, childrenAt, entryEnd, 'colr', budget);
          if (colr !== null && ascii(bytes, colr.start, 4) === 'nclx' && colr.start + 8 <= colr.end) {
            const transfer = ((bytes[colr.start + 6] ?? 0) << 8) | (bytes[colr.start + 7] ?? 0);
            if (transfer === 16) {
              hdr = true;
              colorTransfer = 'BT.2020 PQ';
            } else if (transfer === 18) {
              hdr = true;
              colorTransfer = 'BT.2020 HLG';
            } else {
              hdr = false;
            }
          }
        }
      }
    }
    // stts: one entry = constant frame timing (rate derivable); more = VFR.
    if (type === 'video' && timescale > 0) {
      const stts = findBox(bytes, stbl.start, stbl.end, 'stts', budget);
      if (stts !== null && stts.start + 8 <= stts.end) {
        const entryCount = u32(bytes, stts.start + 4) >>> 0;
        if (entryCount === 1 && stts.start + 16 <= stts.end) {
          const delta = u32(bytes, stts.start + 12) >>> 0;
          if (delta > 0) frameRate = Math.round((timescale / delta) * 1000) / 1000;
        } else if (entryCount > 1) {
          variableFrameRate = true;
        }
      }
    }
  }
  return {
    stream: { type, codec, profile: null },
    width,
    height,
    rotation,
    frameRate,
    variableFrameRate,
    hdr,
    colorTransfer,
  };
}

/** Bounded facts probe for a detected ISO-BMFF/QuickTime movie (§2/§9).
 * Fields the walk never reaches stay null; a missing/torn moov reports
 * `probeIncomplete` (preserved-only until a later pass completes). */
export function probeIsoBmff(bytes: Uint8Array): MediaInfo | null {
  const kind = detectIsoBmff(bytes);
  if (kind === null) return null;
  const budget = { boxes: MAX_BOXES };

  const info: {
    streams: MediaStream[];
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
    rotation: 0 | 90 | 180 | 270 | null;
    frameRate: number | null;
    vfr: boolean;
    hdr: boolean | null;
    colorTransfer: string | null;
    incomplete: boolean;
  } = {
    streams: [],
    durationSeconds: null,
    width: null,
    height: null,
    rotation: null,
    frameRate: null,
    vfr: false,
    hdr: null,
    colorTransfer: null,
    incomplete: true,
  };

  const moov = findBox(bytes, 0, bytes.length, 'moov', budget);
  if (moov !== null) {
    info.incomplete = false;
    const mvhd = findBox(bytes, moov.start, moov.end, 'mvhd', budget);
    if (mvhd !== null) {
      const version = bytes[mvhd.start] ?? 0;
      const timescale = version === 1 ? u32(bytes, mvhd.start + 20) >>> 0 : u32(bytes, mvhd.start + 12) >>> 0;
      const duration = version === 1 ? u64(bytes, mvhd.start + 24) : u32(bytes, mvhd.start + 16) >>> 0;
      if (timescale > 0 && duration > 0) info.durationSeconds = Math.round((duration / timescale) * 1000) / 1000;
    }
    let tracks = 0;
    for (const box of boxes(bytes, moov.start, moov.end, budget)) {
      if (box.type !== 'trak') continue;
      if (tracks >= MAX_TRACKS) {
        info.incomplete = true;
        break;
      }
      tracks += 1;
      const facts = probeTrack(bytes, box, budget);
      if (facts === null) continue;
      info.streams.push(facts.stream);
      if (facts.stream.type === 'video' && info.width === null) {
        info.width = facts.width;
        info.height = facts.height;
        info.rotation = facts.rotation;
        info.frameRate = facts.frameRate;
        info.vfr = facts.variableFrameRate;
        info.hdr = facts.hdr;
        info.colorTransfer = facts.colorTransfer;
      }
    }
    if (budget.boxes <= 0) info.incomplete = true;
  }

  const rotated = info.rotation === 90 || info.rotation === 270;
  return {
    animated: false,
    frameCount: null,
    loopCount: null,
    container: kind,
    streams: info.streams,
    durationSeconds: info.durationSeconds,
    codedWidth: info.width,
    codedHeight: info.height,
    displayWidth: rotated ? info.height : info.width,
    displayHeight: rotated ? info.width : info.height,
    rotationDegrees: info.rotation,
    frameRate: info.frameRate,
    variableFrameRate: info.vfr,
    audioPresent: info.streams.some((stream) => stream.type === 'audio'),
    hdr: info.hdr,
    colorTransfer: info.colorTransfer,
    ...(info.incomplete ? { probeIncomplete: true } : {}),
  };
}
