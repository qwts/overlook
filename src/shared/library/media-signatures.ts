import type { MediaInfo } from './media-info.js';
import { detectTsLayout, probeTransportStream } from './mpeg-ts.js';
import { detectEbml, probeEbml } from './ebml.js';
import { detectIsoBmff, probeIsoBmff } from './iso-bmff.js';
import { detectAvi, probeAvi } from './riff-avi.js';
import { detectMpegAudio, detectMpegPs, probeMpegAudio, probeMpegPs } from './mpeg-ps.js';
import type { FileKind, ImageFileKind } from './types.js';

// Signature-first classification per ADR-0026 §2: content decides, names
// hint. Pure, bounded byte inspection — no decoding, no dependencies — so
// every process (import engine, tests) shares one recognizer. RAW containers
// are deliberately absent: they are TIFF-shaped and owned by the dedicated
// resolvers (raf-preview et al.), so the sniffer returns null and the
// extension classification stands.

const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] as const; // "GIF87a"
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] as const; // "GIF89a"
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Probe budget: a hostile frame table must not turn import into a crawl. */
const MAX_PROBED_FRAMES = 10_000;

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string | null {
  if (bytes.length < offset + length) return null;
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function u16le(bytes: Uint8Array, offset: number): number | null {
  const low = bytes[offset];
  const high = bytes[offset + 1];
  if (low === undefined || high === undefined) return null;
  return low | (high << 8);
}

function u32le(bytes: Uint8Array, offset: number): number | null {
  const low = u16le(bytes, offset);
  const high = u16le(bytes, offset + 2);
  if (low === null || high === null) return null;
  return low + high * 0x1_0000;
}

function isHeicBrand(brand: string): boolean {
  return ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis'].includes(brand);
}

/**
 * Classifies image bytes by signature; null when no supported still/animated
 * image signature matches (callers keep their extension-derived kind — the
 * sniffer only ever *corrects* toward evidence, ADR-0026 §2).
 */
export function sniffImageKind(bytes: Uint8Array): ImageFileKind | null {
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, PNG)) return 'png';
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand !== null && isHeicBrand(brand)) return 'heic';
  }
  return null;
}

/** Skips a GIF data-sub-block chain; returns the offset after its terminator,
 * or null when the buffer ends first (truncated file). */
function skipGifSubBlocks(bytes: Uint8Array, offset: number): number | null {
  let cursor = offset;
  for (;;) {
    const size = bytes[cursor];
    if (size === undefined) return null;
    cursor += 1;
    if (size === 0) return cursor;
    cursor += size;
  }
}

function probeGif(bytes: Uint8Array): MediaInfo {
  // Header (6) + logical screen descriptor (7); the packed byte's bit 7
  // announces a global color table sized 3·2^(N+1).
  let frames = 0;
  let loopCount: number | null = null;
  let truncated = false;
  const packed = bytes[10];
  let cursor = 13;
  if (packed === undefined) {
    return { animated: false, frameCount: null, loopCount: null };
  }
  if ((packed & 0x80) !== 0) {
    cursor += 3 * 2 ** ((packed & 0x07) + 1);
  }
  scan: while (frames < MAX_PROBED_FRAMES) {
    const marker = bytes[cursor];
    cursor += 1;
    switch (marker) {
      case undefined: // ran off the end — truncated, keep what we counted
        truncated = true;
        break scan;
      case 0x3b: // trailer — clean end of stream
        break scan;
      case 0x2c: {
        // Image descriptor: 9 fixed bytes (frame geometry + packed byte with
        // an optional local color table), then LZW min-code byte, then data.
        frames += 1;
        const localPacked = bytes[cursor + 8];
        if (localPacked === undefined) {
          truncated = true;
          break scan;
        }
        cursor += 9 + ((localPacked & 0x80) === 0 ? 0 : 3 * 2 ** ((localPacked & 0x07) + 1)) + 1;
        const next = skipGifSubBlocks(bytes, cursor);
        if (next === null) {
          truncated = true;
          break scan;
        }
        cursor = next;
        break;
      }
      case 0x21: {
        // Extension: label byte, then sub-blocks. NETSCAPE2.0's payload is
        // [0x01, loop lo, loop hi]; loop 0 means forever.
        const label = bytes[cursor];
        cursor += 1;
        if (label === undefined) {
          truncated = true;
          break scan;
        }
        if (label === 0xff && bytes[cursor] === 11 && ascii(bytes, cursor + 1, 11) === 'NETSCAPE2.0') {
          const declared = bytes[cursor + 12] === 3 && bytes[cursor + 13] === 1 ? u16le(bytes, cursor + 14) : null;
          if (declared !== null) loopCount = declared;
        }
        const next = skipGifSubBlocks(bytes, cursor);
        if (next === null) {
          truncated = true;
          break scan;
        }
        cursor = next;
        break;
      }
      default: // unknown marker — stop counting rather than misread garbage
        truncated = true;
        break scan;
    }
  }
  const capped = frames >= MAX_PROBED_FRAMES;
  return {
    animated: frames > 1,
    frameCount: truncated || capped ? null : frames,
    loopCount,
  };
}

function probeWebp(bytes: Uint8Array): MediaInfo {
  // RIFF chunk walk. Static WebP (VP8/VP8L, or VP8X without the ANIM flag)
  // is a single frame; animated files carry ANIM (loop count) + ANMF frames.
  let animated = false;
  let frames = 0;
  let loopCount: number | null = null;
  let truncated = false;
  let cursor = 12;
  const riffEnd = (() => {
    const declared = u32le(bytes, 4);
    return declared === null ? bytes.length : Math.min(bytes.length, 8 + declared);
  })();
  while (cursor + 8 <= riffEnd && frames < MAX_PROBED_FRAMES) {
    const tag = ascii(bytes, cursor, 4);
    const size = u32le(bytes, cursor + 4);
    if (tag === null || size === null) {
      truncated = true;
      break;
    }
    if (tag === 'VP8X') {
      const flags = bytes[cursor + 8];
      if (flags === undefined) {
        truncated = true;
        break;
      }
      animated ||= (flags & 0x02) !== 0;
    } else if (tag === 'ANIM') {
      animated = true;
      loopCount = u16le(bytes, cursor + 12);
    } else if (tag === 'ANMF') {
      frames += 1;
    }
    const advance = cursor + 8 + size + (size % 2); // chunks pad to even
    if (advance + 8 > riffEnd && advance !== riffEnd) {
      truncated = advance > riffEnd;
      break;
    }
    cursor = advance;
  }
  if (!animated) {
    return { animated: false, frameCount: truncated ? null : 1, loopCount: null };
  }
  const capped = frames >= MAX_PROBED_FRAMES;
  return { animated: true, frameCount: truncated || capped || frames === 0 ? null : frames, loopCount };
}

/**
 * Signature-first classification for the container kinds (ADR-0026 §2).
 * MPEG-TS cadence (#548); ISO-BMFF/QuickTime `ftyp` brands, EBML DocType,
 * RIFF/AVI, MPEG-PS packs, and MP2/MP3 frame cadence (#549 — audio-only
 * elementary streams classify as AUDIO, never fake video). Names never
 * decide; null when no container signature matches.
 */
export function sniffVideoKind(bytes: Uint8Array): Extract<FileKind, 'video' | 'audio'> | null {
  if (detectTsLayout(bytes) !== null) return 'video';
  if (detectIsoBmff(bytes) !== null) return 'video';
  if (detectEbml(bytes) !== null) return 'video';
  if (detectAvi(bytes)) return 'video';
  if (detectMpegPs(bytes)) return 'video';
  if (detectMpegAudio(bytes) !== null) return 'audio';
  return null;
}

/**
 * Bounded probe (ADR-0026 §2/§9) for signature-validated media bytes. GIF/WebP
 * animation facts (#547); MPEG-TS facts (#548); ISO-BMFF/QuickTime, EBML,
 * AVI, MPEG-PS, and MPEG-audio facts (#549). Truncated or hostile input
 * degrades fields to null / `probeIncomplete` — probe results are facts or
 * absent, never guesses. Returns null for kinds without probed facts.
 */
export function probeMediaInfo(bytes: Uint8Array, kind: FileKind): MediaInfo | null {
  if (kind === 'gif' && sniffImageKind(bytes) === 'gif') return probeGif(bytes);
  if (kind === 'webp' && sniffImageKind(bytes) === 'webp') return probeWebp(bytes);
  if (kind === 'video' || kind === 'audio') {
    if (detectTsLayout(bytes) !== null) return probeTransportStream(bytes);
    if (detectIsoBmff(bytes) !== null) return probeIsoBmff(bytes);
    if (detectEbml(bytes) !== null) return probeEbml(bytes);
    if (detectAvi(bytes)) return probeAvi(bytes);
    if (detectMpegPs(bytes)) return probeMpegPs(bytes);
    if (detectMpegAudio(bytes) !== null) return probeMpegAudio(bytes);
  }
  return null;
}
