import type { FileKind } from './types.js';

// Media-file allowlist (#84) per ADR-0006 + ADR-0026: only these extensions
// are import candidates; everything else on a card (sidecars, videos, DCIM
// cruft) is ignored by the scanner. RAW list mirrors ADR-0006's
// embedded-preview vocabulary; the extension is only a hint — the import
// engine re-classifies from the byte signature (ADR-0026 §2).

const KIND_BY_EXTENSION: Readonly<Record<string, FileKind>> = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  heic: 'heic',
  heif: 'heic',
  gif: 'gif',
  webp: 'webp',
  raf: 'raw',
  cr2: 'raw',
  cr3: 'raw',
  nef: 'raw',
  arw: 'raw',
  dng: 'raw',
  orf: 'raw',
  rw2: 'raw',
  // MPEG-TS containers (#548, ADR-0026 §2). The extension is only a candidate
  // hint; the import engine validates the 0x47 packet cadence and reclassifies
  // from the signature, so a mislabelled `.ts` is never trusted as video.
  ts: 'video',
  mts: 'video',
  m2ts: 'video',
  // Common video containers (#549, ADR-0026 §2): ISO-BMFF/MP4, QuickTime,
  // WebM/Matroska, AVI, MPEG-PS. Hints only — every candidate is signature-
  // confirmed before the scan promises it and before the engine inserts.
  mp4: 'video',
  m4v: 'video',
  mpeg4: 'video',
  mov: 'video',
  qt: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  mpg: 'video',
  mpeg: 'video',
  // `.mp2` may be MPEG-PS video or an elementary audio stream; the signature
  // decides (an audio cadence classifies as audio, never fake video). `.mp3`
  // admits the same elementary-audio path (PR #856 review).
  mp2: 'audio',
  mp3: 'audio',
};

/** FileKind for an import candidate, or null when not a media file. */
export function classifyMediaFile(fileName: string): FileKind | null {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) {
    return null;
  }
  // AppleDouble/hidden sidecars (._IMG_0001.JPG, .DS_Store) are never media.
  if (fileName.startsWith('.')) {
    return null;
  }
  return KIND_BY_EXTENSION[fileName.slice(dot + 1).toLowerCase()] ?? null;
}
