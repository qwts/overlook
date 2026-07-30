import type { MediaInfo, MediaStream } from './media-info.js';

// MPEG Program Stream (ISO/IEC 13818-1 §2.5) and MPEG elementary audio
// (MP2/MP3) signature + bounded probes per ADR-0026 §2/§9 (#549). Pure byte
// inspection. An audio-only `.mp2` classifies as AUDIO by its frame-sync
// cadence — never misrepresented as video (issue acceptance); a program
// stream classifies by its pack-header start codes. Legacy MPEG-1/2 video is
// preserved-only in v1 (no new native decoders).

/** Probe bounds (§9): start codes scanned in the head window, and the
 * consecutive audio frames a signature must sustain. */
const MAX_SCAN_BYTES = 256 * 1024;
const MIN_PS_PACKS = 2;
const MIN_AUDIO_FRAMES = 4;

/** MPEG audio frame-header tables (ISO/IEC 11172-3). Indexed by the header's
 * bitrate/samplerate fields; 0/`null` = invalid. */
const BITRATES_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0] as const;
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0] as const;
const BITRATES_V2_L23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0] as const;
const SAMPLE_RATES_V1 = [44_100, 48_000, 32_000, 0] as const;

interface AudioFrame {
  readonly length: number;
  readonly codec: 'MP2' | 'MP3';
  readonly bitrateKbps: number;
}

/** Parses one MPEG audio frame header at `at`, or null. Layer I is not in
 * the reviewed matrix; free-format (bitrate index 0) is rejected because its
 * frame length is underivable. */
function audioFrameAt(bytes: Uint8Array, at: number): AudioFrame | null {
  const b0 = bytes[at];
  const b1 = bytes[at + 1];
  const b2 = bytes[at + 2];
  if (b0 !== 0xff || b1 === undefined || b2 === undefined || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 0x03; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layerBits = (b1 >> 1) & 0x03; // 2 = Layer II, 1 = Layer III
  if (versionBits === 1 || (layerBits !== 1 && layerBits !== 2)) return null;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;
  const mpeg1 = versionBits === 3;
  const table = mpeg1 ? (layerBits === 2 ? BITRATES_V1_L2 : BITRATES_V1_L3) : BITRATES_V2_L23;
  const bitrateKbps = table[bitrateIndex] ?? 0;
  let sampleRate = SAMPLE_RATES_V1[sampleRateIndex] ?? 0;
  if (versionBits === 2) sampleRate /= 2;
  if (versionBits === 0) sampleRate /= 4;
  if (bitrateKbps === 0 || sampleRate === 0) return null;
  const padding = (b2 >> 1) & 0x01;
  const samples = layerBits === 2 ? 1152 : mpeg1 ? 1152 : 576;
  const length = Math.floor((samples / 8) * ((bitrateKbps * 1000) / sampleRate)) + padding;
  if (length < 24) return null;
  return { length, codec: layerBits === 2 ? 'MP2' : 'MP3', bitrateKbps };
}

/** Skips a leading ID3v2 tag so tagged files still signature-classify. */
function afterId3(bytes: Uint8Array): number {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size =
    (((bytes[6] ?? 0) & 0x7f) << 21) | (((bytes[7] ?? 0) & 0x7f) << 14) | (((bytes[8] ?? 0) & 0x7f) << 7) | ((bytes[9] ?? 0) & 0x7f);
  return Math.min(10 + size, bytes.length);
}

/** Signature-first audio classification: a sustained MP2/MP3 frame cadence.
 * One stray sync word proves nothing (§2). */
export function detectMpegAudio(bytes: Uint8Array): 'MP2' | 'MP3' | null {
  const at = afterId3(bytes);
  const first = audioFrameAt(bytes, at);
  if (first === null) return null;
  let confirmed = 0;
  let cursor = at;
  for (let i = 0; i < MIN_AUDIO_FRAMES; i++) {
    const frame = audioFrameAt(bytes, cursor);
    // A frame counts only when its DECLARED length is fully present — a bare
    // header at EOF proves nothing (PR #856 review), so truncated or spoofed
    // ff-fx prefixes never classify.
    if (frame === null || frame.codec !== first.codec || cursor + frame.length > bytes.length) break;
    confirmed += 1;
    cursor += frame.length;
  }
  return confirmed === MIN_AUDIO_FRAMES ? first.codec : null;
}

/** Bounded facts probe for detected MPEG elementary audio. Duration is the
 * CBR estimate; VBR files record null rather than a guess (§9). */
export function probeMpegAudio(bytes: Uint8Array): MediaInfo | null {
  const codec = detectMpegAudio(bytes);
  if (codec === null) return null;
  const at = afterId3(bytes);
  const first = audioFrameAt(bytes, at);
  let constantBitrate = true;
  let scanned = 0;
  let cursor = at;
  while (cursor < bytes.length && scanned < 64) {
    const frame = audioFrameAt(bytes, cursor);
    if (frame === null) break;
    if (frame.bitrateKbps !== first?.bitrateKbps) {
      constantBitrate = false;
      break;
    }
    cursor += frame.length;
    scanned += 1;
  }
  const durationSeconds =
    constantBitrate && first !== null && first.bitrateKbps > 0
      ? Math.round(((bytes.length - at) / ((first.bitrateKbps * 1000) / 8)) * 1000) / 1000
      : null;
  return {
    animated: false,
    frameCount: null,
    loopCount: null,
    container: 'MPEG-Audio',
    streams: [{ type: 'audio', codec, profile: null }],
    durationSeconds,
    codedWidth: null,
    codedHeight: null,
    displayWidth: null,
    displayHeight: null,
    rotationDegrees: null,
    frameRate: null,
    variableFrameRate: false,
    audioPresent: true,
    hdr: null,
    colorTransfer: null,
  };
}

/** Signature-first program-stream classification: a pack start code
 * (00 00 01 BA) at offset 0 plus at least one more within the head window —
 * a lone start code proves nothing (§2). */
export function detectMpegPs(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 0x01 || bytes[3] !== 0xba) return false;
  let packs = 1;
  const end = Math.min(bytes.length - 3, MAX_SCAN_BYTES);
  for (let at = 4; at < end && packs < MIN_PS_PACKS; at++) {
    if (bytes[at] === 0 && bytes[at + 1] === 0 && bytes[at + 2] === 0x01 && bytes[at + 3] === 0xba) packs += 1;
  }
  // The cadence must actually be seen — a lone pack header on a short file
  // proves nothing (PR #856 review).
  return packs >= MIN_PS_PACKS;
}

/** Bounded facts probe for a detected program stream: PES start codes name
 * the elementary streams; the pack header names MPEG-1 vs MPEG-2 video.
 * Duration stays null in v1 — SCR math needs tail parsing the §9 budget
 * spends better elsewhere; the record is facts or absent, never guesses. */
export function probeMpegPs(bytes: Uint8Array): MediaInfo | null {
  if (!detectMpegPs(bytes)) return null;
  // MPEG-2 packs mark the version with '01' in the top bits of byte 4;
  // MPEG-1 packs use '0010'.
  const mpeg2 = ((bytes[4] ?? 0) & 0xc0) === 0x40;
  const videoCodec = mpeg2 ? 'MPEG-2 Video' : 'MPEG-1 Video';
  let videoStreams = 0;
  let audioStreams = 0;
  const end = Math.min(bytes.length - 3, MAX_SCAN_BYTES);
  const seen = new Set<number>();
  for (let at = 0; at < end; at++) {
    if (bytes[at] !== 0 || bytes[at + 1] !== 0 || bytes[at + 2] !== 0x01) continue;
    const id = bytes[at + 3] ?? 0;
    if (seen.has(id)) continue;
    if (id >= 0xe0 && id <= 0xef) {
      seen.add(id);
      videoStreams += 1;
    } else if (id >= 0xc0 && id <= 0xdf) {
      seen.add(id);
      audioStreams += 1;
    }
  }
  const streams: MediaStream[] = [
    ...Array.from({ length: videoStreams }, (): MediaStream => ({ type: 'video', codec: videoCodec, profile: null })),
    ...Array.from({ length: audioStreams }, (): MediaStream => ({ type: 'audio', codec: 'MP2', profile: null })),
  ];
  return {
    animated: false,
    frameCount: null,
    loopCount: null,
    container: 'MPEG-PS',
    streams,
    durationSeconds: null,
    codedWidth: null,
    codedHeight: null,
    displayWidth: null,
    displayHeight: null,
    rotationDegrees: null,
    frameRate: null,
    variableFrameRate: false,
    audioPresent: audioStreams > 0,
    hdr: null,
    colorTransfer: null,
    // The head window may not have shown every stream; the §9 budget stops
    // here regardless, so the record says so when nothing video was seen.
    ...(videoStreams === 0 ? { probeIncomplete: true } : {}),
  };
}
