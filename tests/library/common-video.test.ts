import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { detectIsoBmff, probeIsoBmff } from '../../src/shared/library/iso-bmff.js';
import { detectEbml, probeEbml } from '../../src/shared/library/ebml.js';
import { detectAvi, probeAvi } from '../../src/shared/library/riff-avi.js';
import { detectMpegAudio, detectMpegPs, probeMpegAudio, probeMpegPs } from '../../src/shared/library/mpeg-ps.js';
import { probeMediaInfo, sniffImageKind, sniffVideoKind } from '../../src/shared/library/media-signatures.js';
import { classifyMediaFile } from '../../src/shared/library/media-files.js';
import { videoMimeFor } from '../../src/shared/library/media-info.js';
import { derivePlayability, type DeviceMediaCapabilities } from '../../src/shared/library/playability.js';

// Common video containers (#549, ADR-0026 §2/§3/§9): signature-first
// classification and bounded probes for ISO-BMFF/QuickTime, EBML, AVI,
// MPEG-PS, and MPEG elementary audio, plus the per-device playability
// derivation over the recorded facts. Fixtures are byte-built: structurally
// valid containers with known facts, no binary blobs.

// ---------------------------------------------------------------- builders

function ascii4(type: string): number[] {
  return [...type].map((ch) => ch.charCodeAt(0));
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(8 + body.length), ...ascii4(type), ...body];
}

const IDENTITY_MATRIX = [
  ...u32(0x0001_0000),
  ...u32(0),
  ...u32(0),
  ...u32(0),
  ...u32(0x0001_0000),
  ...u32(0),
  ...u32(0),
  ...u32(0),
  ...u32(0x4000_0000),
];
const ROTATE_90_MATRIX = [
  ...u32(0),
  ...u32(0x0001_0000),
  ...u32(0),
  ...u32(-0x0001_0000 | 0),
  ...u32(0),
  ...u32(0),
  ...u32(0),
  ...u32(0),
  ...u32(0x4000_0000),
];

interface Mp4Track {
  readonly handler: 'vide' | 'soun';
  readonly fourcc: string;
  readonly width?: number;
  readonly height?: number;
  readonly rotated?: boolean;
  /** stts entries: [count, delta][] against a 30_000 media timescale. */
  readonly stts?: readonly (readonly [number, number])[];
  /** colr nclx transfer code (16 = PQ). */
  readonly transfer?: number;
}

function mp4Trak(track: Mp4Track): number[] {
  const width = track.width ?? 0;
  const height = track.height ?? 0;
  const tkhd = box('tkhd', [
    ...u32(0), // version 0 + flags
    ...u32(0),
    ...u32(0),
    ...u32(1), // track id
    ...u32(0),
    ...u32(0),
    ...u32(0),
    ...u32(0), // reserved(4) + duration + reserved(8)
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u16(0), // layer, alt group, volume, reserved
    ...(track.rotated === true ? ROTATE_90_MATRIX : IDENTITY_MATRIX),
    ...u32(width << 16),
    ...u32(height << 16),
  ]);
  const colr = track.transfer === undefined ? [] : box('colr', ascii4('nclx'), u16(9), u16(track.transfer), u16(9), [0x80]);
  const sampleEntry = box(track.fourcc, [
    ...Array.from({ length: 6 }, () => 0),
    ...u16(1), // data_ref_index
    ...Array.from({ length: 16 }, () => 0),
    ...u16(width),
    ...u16(height),
    ...u32(0x0048_0000),
    ...u32(0x0048_0000),
    ...u32(0),
    ...u16(1),
    ...Array.from({ length: 32 }, () => 0),
    ...u16(24),
    ...u16(0xffff),
    ...colr,
  ]);
  const stts = box(
    'stts',
    u32(0),
    u32((track.stts ?? []).length),
    (track.stts ?? []).flatMap(([count, delta]) => [...u32(count), ...u32(delta)]),
  );
  const stsd = box('stsd', u32(0), u32(1), sampleEntry);
  const stbl = box('stbl', stsd, stts);
  const minf = box('minf', stbl);
  const mdhd = box('mdhd', u32(0), u32(0), u32(0), u32(30_000), u32(0), u16(0x55c4), u16(0));
  const hdlr = box('hdlr', u32(0), u32(0), ascii4(track.handler), u32(0), u32(0), u32(0), [0]);
  const mdia = box('mdia', mdhd, hdlr, minf);
  return box('trak', tkhd, mdia);
}

function buildMp4(options: { brand?: string; tracks: readonly Mp4Track[]; durationSeconds?: number; omitMoov?: boolean }): Uint8Array {
  const brand = options.brand ?? 'isom';
  const ftyp = box('ftyp', ascii4(brand), u32(0x200), ascii4('isom'), ascii4('mp41'));
  const mvhd = box(
    'mvhd',
    u32(0),
    u32(0),
    u32(0),
    u32(1000), // timescale
    u32(Math.round((options.durationSeconds ?? 0) * 1000)),
    u32(0x0001_0000),
    u16(0x0100),
    u16(0),
    u32(0),
    u32(0),
    IDENTITY_MATRIX,
    Array.from({ length: 24 }, () => 0),
    u32(2),
  );
  const moov = box('moov', mvhd, ...options.tracks.map(mp4Trak));
  const mdat = box('mdat', [0, 0, 0, 0]);
  return Uint8Array.from([...ftyp, ...(options.omitMoov === true ? [] : moov), ...mdat]);
}

function ebmlElement(id: number, payload: number[]): number[] {
  const idBytes = id > 0xffffff ? u32(id) : id > 0xffff ? u32(id).slice(1) : id > 0xff ? u16(id) : [id];
  if (payload.length > 126) throw new Error('fixture element too large for 1-byte size');
  return [...idBytes, 0x80 | payload.length, ...payload];
}

function ebmlUint(id: number, value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  return ebmlElement(id, bytes);
}

function ebmlString(id: number, value: string): number[] {
  return ebmlElement(id, ascii4(value.padEnd(0)).slice(0, value.length));
}

function buildWebm(options: {
  doctype: 'webm' | 'matroska';
  tracks: readonly { type: 1 | 2; codec: string; width?: number; height?: number }[];
  durationSeconds?: number;
}): Uint8Array {
  const header = ebmlElement(0xa3, []); // placeholder, replaced below
  void header;
  const ebmlHeader = [
    0x1a,
    0x45,
    0xdf,
    0xa3,
    ...(() => {
      const body = [
        ...ebmlUint(0x4286, 1),
        ...ebmlUint(0x42f7, 1),
        ...ebmlUint(0x42f2, 4),
        ...ebmlUint(0x42f3, 8),
        ...ebmlString(0x4282, options.doctype),
        ...ebmlUint(0x4287, 2),
        ...ebmlUint(0x4285, 2),
      ];
      return [0x80 | body.length, ...body];
    })(),
  ];
  const duration =
    options.durationSeconds === undefined
      ? []
      : ebmlElement(
          0x4489,
          (() => {
            const view = new DataView(new ArrayBuffer(8));
            view.setFloat64(0, options.durationSeconds * 1000);
            return [...new Uint8Array(view.buffer)];
          })(),
        );
  const info = ebmlElement(0x49, []); // unused
  void info;
  const infoBody = [...ebmlUint(0x2ad7b1, 1_000_000), ...duration];
  const infoElement = [0x15, 0x49, 0xa9, 0x66, 0x80 | infoBody.length, ...infoBody];
  const trackEntries = options.tracks.flatMap((track) => {
    const video =
      track.width === undefined ? [] : ebmlElement(0xe0, [...ebmlUint(0xb0, track.width), ...ebmlUint(0xba, track.height ?? 0)]);
    const body = [
      ...ebmlUint(0x83, track.type),
      ...ebmlElement(
        0x86,
        [...track.codec].map((ch) => ch.charCodeAt(0)),
      ),
      ...video,
    ];
    return ebmlElement(0xae, body);
  });
  const tracksElement = [0x16, 0x54, 0xae, 0x6b, 0x80 | trackEntries.length, ...trackEntries];
  const segmentBody = [...infoElement, ...tracksElement];
  const segment = [0x18, 0x53, 0x80, 0x67, 0x80 | segmentBody.length, ...segmentBody];
  return Uint8Array.from([...ebmlHeader, ...segment]);
}

function riffChunk(id: string, payload: number[]): number[] {
  const padded = payload.length % 2 === 0 ? payload : [...payload, 0];
  return [...ascii4(id), ...u32le(payload.length), ...padded];
}

function riffList(type: string, payload: number[]): number[] {
  return riffChunk('LIST', [...ascii4(type), ...payload]);
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function buildAvi(options: { width: number; height: number; fps: number; frames: number; audioTag?: number }): Uint8Array {
  const microSecPerFrame = Math.round(1_000_000 / options.fps);
  const avih = riffChunk('avih', [
    ...u32le(microSecPerFrame),
    ...u32le(0),
    ...u32le(0),
    ...u32le(0),
    ...u32le(options.frames),
    ...u32le(0),
    ...u32le(options.audioTag === undefined ? 1 : 2),
    ...u32le(0),
    ...u32le(options.width),
    ...u32le(options.height),
    ...Array.from({ length: 16 }, () => 0),
  ]);
  const videoStrl = riffList('strl', [
    ...riffChunk('strh', [...ascii4('vids'), ...ascii4('XVID'), ...Array.from({ length: 48 }, () => 0)]),
    ...riffChunk(
      'strf',
      Array.from({ length: 40 }, () => 0),
    ),
  ]);
  const audioStrl =
    options.audioTag === undefined
      ? []
      : riffList('strl', [
          ...riffChunk('strh', [...ascii4('auds'), ...u32le(0), ...Array.from({ length: 48 }, () => 0)]),
          ...riffChunk('strf', [...u16le(options.audioTag), ...Array.from({ length: 14 }, () => 0)]),
        ]);
  const hdrl = riffList('hdrl', [...avih, ...videoStrl, ...audioStrl]);
  const movi = riffList('movi', [0, 0, 0, 0]);
  const body = [...ascii4('AVI '), ...hdrl, ...movi];
  return Uint8Array.from([...ascii4('RIFF'), ...u32le(body.length), ...body]);
}

function buildMpegPs(options: { withAudio?: boolean } = {}): Uint8Array {
  const pack = [0, 0, 1, 0xba, 0x44, 0, 4, 0, 4, 1, 0, 0, 3, 0xf8];
  const videoPes = [0, 0, 1, 0xe0, 0, 8, 0x80, 0, 0, 1, 2, 3, 4, 5];
  const audioPes = options.withAudio === true ? [0, 0, 1, 0xc0, 0, 8, 0x80, 0, 0, 9, 8, 7, 6, 5] : [];
  return Uint8Array.from([...pack, ...videoPes, ...pack, ...audioPes]);
}

/** 4 chained MPEG-1 Layer II frames: 0xFFFD = MPEG-1 L2, 128 kbps @ 44.1k. */
function buildMp2(frames = 6): Uint8Array {
  const frameLength = Math.floor((1152 / 8) * ((128 * 1000) / 44_100));
  const frame = [0xff, 0xfd, 0x80, 0x00, ...Array.from({ length: frameLength - 4 }, () => 0xaa)];
  return Uint8Array.from(Array.from({ length: frames }, () => frame).flat());
}

const DECODE_ALL: DeviceMediaCapabilities = { canDecodeCodec: () => true, transportStreamRemuxAvailable: true };

// ------------------------------------------------------------------- tests

describe('ISO-BMFF / QuickTime (#549)', () => {
  test('EXIT CRITERIA: an iPhone-shaped HEVC QuickTime records container, codec, rotation, dimensions, audio, and HDR facts', () => {
    const bytes = buildMp4({
      brand: 'qt  ',
      durationSeconds: 12.5,
      tracks: [
        { handler: 'vide', fourcc: 'hvc1', width: 3840, height: 2160, rotated: true, stts: [[100, 1001]], transfer: 16 },
        { handler: 'soun', fourcc: 'mp4a' },
      ],
    });
    assert.equal(detectIsoBmff(bytes), 'QuickTime');
    assert.equal(sniffVideoKind(bytes), 'video');
    const info = probeIsoBmff(bytes);
    assert.ok(info);
    assert.equal(info.container, 'QuickTime');
    assert.deepEqual(
      info.streams?.map((stream) => stream.codec),
      ['H.265', 'AAC'],
    );
    assert.equal(info.durationSeconds, 12.5);
    assert.equal(info.codedWidth, 3840);
    assert.equal(info.rotationDegrees, 90);
    assert.equal(info.displayWidth, 2160, 'display dims follow rotation');
    assert.equal(info.frameRate, Math.round((30_000 / 1001) * 1000) / 1000);
    assert.equal(info.audioPresent, true);
    assert.equal(info.hdr, true);
    assert.equal(info.colorTransfer, 'BT.2020 PQ');
    assert.notEqual(info.probeIncomplete, true);
  });

  test('MP4 brands classify MP4; ProRes fourccs label ProRes; VFR is flagged', () => {
    const bytes = buildMp4({
      tracks: [
        {
          handler: 'vide',
          fourcc: 'apch',
          width: 1920,
          height: 1080,
          stts: [
            [10, 1001],
            [10, 2002],
          ],
        },
      ],
    });
    assert.equal(detectIsoBmff(bytes), 'MP4');
    const info = probeIsoBmff(bytes);
    assert.equal(info?.streams?.[0]?.codec, 'ProRes');
    assert.equal(info?.variableFrameRate, true);
    assert.equal(info?.frameRate, null);
  });

  test('still-image ftyp brands are not video; a spoofed JPEG never classifies as a container', () => {
    const heic = Uint8Array.from([...u32(24), ...ascii4('ftyp'), ...ascii4('heic'), ...u32(0), ...ascii4('mif1'), ...ascii4('heic')]);
    assert.equal(detectIsoBmff(heic), null);
    const jpeg = readFileSync(join(import.meta.dirname, '../../../tests/fixtures/exif/exif-stripped.jpg'));
    assert.equal(sniffImageKind(jpeg), 'jpeg');
    assert.equal(detectIsoBmff(jpeg), null);
  });

  test('a moov-less (truncated) movie is preserved with probeIncomplete, never a throw', () => {
    const info = probeIsoBmff(buildMp4({ omitMoov: true, tracks: [] }));
    assert.ok(info);
    assert.equal(info.probeIncomplete, true);
  });
});

describe('EBML: WebM and provisional Matroska (#549)', () => {
  test('DocType decides the container; tracks record codecs and dimensions', () => {
    const bytes = buildWebm({
      doctype: 'webm',
      durationSeconds: 4,
      tracks: [
        { type: 1, codec: 'V_VP9', width: 1280, height: 720 },
        { type: 2, codec: 'A_OPUS' },
      ],
    });
    assert.equal(detectEbml(bytes), 'WebM');
    assert.equal(sniffVideoKind(bytes), 'video');
    const info = probeEbml(bytes);
    assert.equal(info?.container, 'WebM');
    assert.deepEqual(
      info?.streams?.map((stream) => stream.codec),
      ['VP9', 'Opus'],
    );
    assert.equal(info?.durationSeconds, 4);
    assert.equal(info?.codedWidth, 1280);
    assert.equal(info?.audioPresent, true);
  });

  test('matroska DocType records Matroska and derives preserved-only even with decodable codecs (provisional gate)', () => {
    const bytes = buildWebm({ doctype: 'matroska', tracks: [{ type: 1, codec: 'V_VP9', width: 640, height: 360 }] });
    assert.equal(detectEbml(bytes), 'Matroska');
    const info = probeEbml(bytes);
    assert.equal(info?.container, 'Matroska');
    assert.equal(derivePlayability('video', info, DECODE_ALL), 'preserved-only');
  });

  test('EBML-shaped non-media bytes are rejected', () => {
    const bytes = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x82, 0x81, 0x78]);
    assert.equal(detectEbml(bytes), null);
  });
});

describe('RIFF/AVI (#549)', () => {
  test('avih facts record dimensions, frame rate, duration, and streams; legacy codecs stay preserved-only', () => {
    const bytes = buildAvi({ width: 720, height: 480, fps: 25, frames: 250, audioTag: 0x0055 });
    assert.equal(detectAvi(bytes), true);
    assert.equal(sniffVideoKind(bytes), 'video');
    const info = probeAvi(bytes);
    assert.equal(info?.container, 'AVI');
    assert.equal(info?.codedWidth, 720);
    assert.equal(info?.frameRate, 25);
    assert.equal(info?.durationSeconds, 10);
    assert.deepEqual(
      info?.streams?.map((stream) => stream.codec),
      ['MPEG-4 Part 2', 'MP3'],
    );
    assert.equal(derivePlayability('video', info ?? null, DECODE_ALL), 'preserved-only');
  });

  test('a plain RIFF/WAVE is not an AVI', () => {
    const bytes = Uint8Array.from([...ascii4('RIFF'), ...u32le(4), ...ascii4('WAVE')]);
    assert.equal(detectAvi(bytes), false);
  });
});

describe('MPEG-PS and elementary audio (#549)', () => {
  test('pack cadence classifies video; PES start codes inventory streams; preserved-only in v1', () => {
    const bytes = buildMpegPs({ withAudio: true });
    assert.equal(detectMpegPs(bytes), true);
    assert.equal(sniffVideoKind(bytes), 'video');
    const info = probeMpegPs(bytes);
    assert.equal(info?.container, 'MPEG-PS');
    assert.deepEqual(
      info?.streams?.map((stream) => stream.codec),
      ['MPEG-2 Video', 'MP2'],
    );
    assert.equal(derivePlayability('video', info ?? null, DECODE_ALL), 'preserved-only');
  });

  test('ACCEPTANCE: an audio-only .mp2 classifies as AUDIO from its frame cadence, never as video', () => {
    const bytes = buildMp2();
    assert.equal(detectMpegPs(bytes), false);
    assert.equal(detectMpegAudio(bytes), 'MP2');
    assert.equal(sniffVideoKind(bytes), 'audio');
    assert.equal(classifyMediaFile('concert.mp2'), 'audio');
    const info = probeMpegAudio(bytes);
    assert.equal(info?.container, 'MPEG-Audio');
    assert.equal(info?.streams?.[0]?.codec, 'MP2');
    assert.equal(info?.audioPresent, true);
    assert.ok((info?.durationSeconds ?? 0) > 0, 'CBR duration estimated');
  });

  test('REGRESSION (PR #856): a bare frame header at EOF and a lone pack header never classify', () => {
    // One valid MP2 header with no frame body behind it.
    const bareHeader = Uint8Array.from([0xff, 0xfd, 0x80, 0x00, 0xaa, 0xaa]);
    assert.equal(detectMpegAudio(bareHeader), null);
    assert.equal(sniffVideoKind(bareHeader), null);
    // One pack start code on a short file, no second pack in the window.
    const lonePack = Uint8Array.from([0, 0, 1, 0xba, 0x44, 0, 4, 0, 4, 1, 0, 0, 3, 0xf8, 9, 9, 9, 9]);
    assert.equal(detectMpegPs(lonePack), false);
    assert.equal(sniffVideoKind(lonePack), null);
  });

  test('random bytes sustain neither cadence', () => {
    const bytes = Uint8Array.from(Array.from({ length: 4096 }, (_, index) => (index * 37) & 0xff));
    assert.equal(detectMpegPs(bytes), false);
    assert.equal(detectMpegAudio(bytes), null);
    assert.equal(sniffVideoKind(bytes), null);
  });
});

describe('playability derivation over the new containers (§3)', () => {
  const caps = (decodable: readonly string[]): DeviceMediaCapabilities => ({
    canDecodeCodec: (codec) => decodable.includes(codec),
    transportStreamRemuxAvailable: false,
  });

  test('MP4 H.264+AAC plays when both streams decode; HEVC follows the platform probe', () => {
    const h264 = probeMediaInfo(
      buildMp4({
        tracks: [
          { handler: 'vide', fourcc: 'avc1', width: 1920, height: 1080, stts: [[1, 1000]] },
          { handler: 'soun', fourcc: 'mp4a' },
        ],
      }),
      'video',
    );
    assert.equal(derivePlayability('video', h264, caps(['H.264', 'AAC'])), 'playable');
    assert.equal(derivePlayability('video', h264, caps(['H.264'])), 'preserved-only', 'undecodable audio blocks playback honestly');
    const hevc = probeMediaInfo(
      buildMp4({ brand: 'qt  ', tracks: [{ handler: 'vide', fourcc: 'hvc1', width: 1920, height: 1080, stts: [[1, 1000]] }] }),
      'video',
    );
    assert.equal(derivePlayability('video', hevc, caps(['H.265'])), 'playable');
    assert.equal(derivePlayability('video', hevc, caps([])), 'preserved-only');
  });

  test('ProRes QuickTime is preserved-only (no decoder entry by design)', () => {
    const prores = probeMediaInfo(
      buildMp4({ brand: 'qt  ', tracks: [{ handler: 'vide', fourcc: 'ap4h', width: 1920, height: 1080, stts: [[1, 1000]] }] }),
      'video',
    );
    assert.equal(derivePlayability('video', prores, caps(['H.264', 'AAC', 'VP9'])), 'preserved-only');
  });

  test('WebM VP9 plays with the codec probe; audio kind has no tier', () => {
    const webm = probeMediaInfo(buildWebm({ doctype: 'webm', tracks: [{ type: 1, codec: 'V_VP9', width: 640, height: 360 }] }), 'video');
    assert.equal(derivePlayability('video', webm, caps(['VP9'])), 'playable');
    assert.equal(derivePlayability('audio', probeMediaInfo(buildMp2(), 'audio'), DECODE_ALL), 'preserved-only');
  });

  test('REGRESSION (PR #856): the capability probe is container-aware — a WebM verdict never vouches for MP4', () => {
    const webmOnly: DeviceMediaCapabilities = {
      canDecodeCodec: (codec, container) => codec === 'VP9' && container === 'WebM',
      transportStreamRemuxAvailable: false,
    };
    const webm = probeMediaInfo(buildWebm({ doctype: 'webm', tracks: [{ type: 1, codec: 'V_VP9', width: 640, height: 360 }] }), 'video');
    const mp4 = probeMediaInfo(
      buildMp4({ tracks: [{ handler: 'vide', fourcc: 'vp09', width: 640, height: 360, stts: [[1, 1000]] }] }),
      'video',
    );
    assert.equal(derivePlayability('video', webm, webmOnly), 'playable');
    assert.equal(derivePlayability('video', mp4, webmOnly), 'preserved-only', 'the MP4 vp09 entry asks about MP4, not WebM');
  });
});

describe('range-served MIME follows the probed container (§5)', () => {
  test('every container maps; unprobed rows keep the legacy transport type', () => {
    assert.equal(videoMimeFor('MP4'), 'video/mp4');
    assert.equal(videoMimeFor('QuickTime'), 'video/mp4', 'MOV serves through the BMFF demuxer family MIME');
    assert.equal(videoMimeFor('WebM'), 'video/webm');
    assert.equal(videoMimeFor('Matroska'), 'video/x-matroska');
    assert.equal(videoMimeFor('AVI'), 'video/x-msvideo');
    assert.equal(videoMimeFor('MPEG-PS'), 'video/mpeg');
    assert.equal(videoMimeFor('MPEG-Audio'), 'audio/mpeg');
    assert.equal(videoMimeFor('MPEG-TS'), 'video/mp2t');
    assert.equal(videoMimeFor(undefined), 'video/mp2t');
  });
});

describe('extension hints admit the new families (§2 — signature still decides)', () => {
  test('requested extensions classify as candidates', () => {
    for (const name of ['a.mp4', 'a.m4v', 'a.mpeg4', 'a.mov', 'a.qt', 'a.webm', 'a.mkv', 'a.avi', 'a.mpg', 'a.mpeg']) {
      assert.equal(classifyMediaFile(name), 'video', name);
    }
    assert.equal(classifyMediaFile('a.mp2'), 'audio');
    assert.equal(classifyMediaFile('a.mp3'), 'audio', 'PR #856: ordinary MP3s admit as audio candidates');
    assert.equal(classifyMediaFile('a.wmv'), null, 'unrequested formats stay out');
  });
});
