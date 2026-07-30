import type { MediaInfo } from './media-info.js';
import type { FileKind } from './types.js';

// ADR-0026 §3: playability is a property of a device, not a file. It is derived
// per device at runtime from (media-info record, device capability set) and is
// NEVER persisted into library rows, backup manifests, or interop payloads — a
// stored "can play" flag becomes a lie the moment the library moves. This
// module is the pure derivation; the capability set is supplied by the caller
// (the renderer probes Chromium's decoders once per codec per session).

export type Playability = 'playable' | 'preserved-only';

export interface DeviceMediaCapabilities {
  /** True when the platform's `<video>`/MSE stack can decode this codec label,
   * as recorded by the probe ('H.264', 'AAC', 'H.265', 'AC-3', …). */
  readonly canDecodeCodec: (codec: string) => boolean;
  /** True when the MPEG-TS → fragmented-MP4 remux adapter (§5) is available
   * this session. MPEG-TS is not servable to `<video>` without it. */
  readonly transportStreamRemuxAvailable: boolean;
}

/** Codecs the §5 MPEG-TS remux adapter can carry into fMP4 in v1. */
const TS_REMUX_VIDEO = 'H.264';
const TS_REMUX_AUDIO = 'AAC';

/**
 * Resolves the per-device playability tier. Preserved-only is the honest
 * default: an item is Playable only when the container is servable and *every*
 * present stream — video and audio — is locally decodable. A decodable video
 * with an undecodable audio track is preserved-only; Photos never plays media
 * with silently missing streams (ADR-0026 §3).
 */
export function derivePlayability(fileKind: FileKind, info: MediaInfo | null, caps: DeviceMediaCapabilities): Playability {
  // `audio` playback UX is deferred (§10); non-media kinds have no tier.
  if (fileKind !== 'video') return 'preserved-only';
  // A probe that never completed cannot claim playability (§2).
  if (info === null || info.probeIncomplete === true) return 'preserved-only';

  const streams = info.streams ?? [];
  const videoStreams = streams.filter((s) => s.type === 'video');
  const audioStreams = streams.filter((s) => s.type === 'audio');
  if (videoStreams.length === 0) return 'preserved-only';

  // Container servability. MPEG-TS (#548) is servable only through the remux
  // adapter, and only for H.264 + AAC in v1. MP4/QuickTime/WebM serve
  // directly to <video> (#549); AVI, Matroska (provisional gate), and
  // MPEG-PS have no servable path in v1 — preserved-only regardless of
  // codecs, with the honest playback-limitation UI.
  if (info.container === 'MPEG-TS') {
    if (!caps.transportStreamRemuxAvailable) return 'preserved-only';
    if (!videoStreams.every((s) => s.codec === TS_REMUX_VIDEO)) return 'preserved-only';
    if (!audioStreams.every((s) => s.codec === TS_REMUX_AUDIO)) return 'preserved-only';
  }
  if (info.container === 'AVI' || info.container === 'Matroska' || info.container === 'MPEG-PS' || info.container === 'MPEG-Audio') {
    return 'preserved-only';
  }

  // Every present stream must be locally decodable.
  for (const stream of [...videoStreams, ...audioStreams]) {
    if (stream.codec === null || !caps.canDecodeCodec(stream.codec)) return 'preserved-only';
  }
  return 'playable';
}
