import { inflateSync } from 'node:zlib';

import exifr from 'exifr';

import type { ProvenanceClaim, ProvenanceSource } from '../../shared/library/provenance.js';
import { plainXmlText } from './xmp-metadata.js';

// Local provenance extraction (#495, ADR-0031 §5). Pure byte inspection —
// bounded, non-validating, never networked: it reports what the file
// DECLARES (XMP source type, creator tool, edit history agents, EXIF
// Software, PNG text chunks written by generators) and whether a C2PA
// credential container is PRESENT. This build ships no C2PA validator or
// trust policy, so a present credential is reported `unverifiable` with a
// null validator; it is never promoted to Verified. Malformed input simply
// contributes nothing.

/** Bytes inspected for an XMP packet; credentials and text chunks walk their
 * own bounded structures. */
/**
 * Only this many leading bytes of an original (or a sidecar) are inspected.
 * Readers hand the extractor at most this much, so inspecting a large RAW or
 * a video never materializes the whole file (#1113 review).
 */
export const PROVENANCE_SCAN_LIMIT = 32 * 1024 * 1024;
const MAX_SOURCES = 64;
const MAX_VALUE = 2000;
const MAX_CHUNKS = 4096;
const MAX_INFLATED = 256 * 1024;

/** Reviewed generator names (lowercase substrings). A tool string naming one
 * of these declares generation; anything else is a tool declaration. */
const GENERATOR_NAMES = [
  'dall·e',
  'dall-e',
  'dalle',
  'midjourney',
  'stable diffusion',
  'stablediffusion',
  'firefly',
  'imagen',
  'gemini',
  'chatgpt',
  'gpt-image',
  'sora',
  'flux.1',
  'black forest labs',
  'ideogram',
  'leonardo.ai',
  'leonardo ai',
  'runway',
  'novelai',
  'comfyui',
  'automatic1111',
  'invokeai',
  'fooocus',
  'bing image creator',
  'meta ai',
  'grok',
  'recraft',
  'dreamstudio',
];

/** IPTC digital source types (cv.iptc.org/newscodes/digitalsourcetype). */
const DIGITAL_SOURCE_CLAIMS: Readonly<Record<string, ProvenanceClaim>> = {
  trainedAlgorithmicMedia: 'generated',
  algorithmicMedia: 'generated',
  compositeWithTrainedAlgorithmicMedia: 'edited',
  compositeSynthetic: 'edited',
  algorithmicallyEnhanced: 'edited',
  digitalCapture: 'capture',
  computationalCapture: 'capture',
  compositeCapture: 'capture',
  minorHumanEdits: 'capture',
  humanEdits: 'capture',
  negativeFilm: 'capture',
  positiveFilm: 'capture',
  print: 'capture',
  screenCapture: 'capture',
  virtualRecording: 'tool',
  digitalCreation: 'tool',
  dataDrivenMedia: 'tool',
};

const C2PA_UUID = Buffer.from('d8fec3d61b0e483c92975828877ec481', 'hex');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function classifyTool(name: string): ProvenanceClaim {
  const lower = name.toLowerCase();
  return GENERATOR_NAMES.some((generator) => lower.includes(generator)) ? 'generated' : 'tool';
}

function bounded(value: string): string {
  const trimmed = value.replace(/\s+/gu, ' ').trim();
  return trimmed.length > MAX_VALUE ? trimmed.slice(0, MAX_VALUE) : trimmed;
}

function declaration(
  origin: 'xmp' | 'exif' | 'png-text' | 'xmp-sidecar',
  field: string,
  value: string,
  claim: ProvenanceClaim,
): ProvenanceSource | null {
  const text = bounded(value);
  return text === '' ? null : { kind: 'declaration', origin, field, value: text, claim };
}

function credential(
  container: 'jpeg-app11' | 'png-caBX' | 'isobmff-uuid' | 'webp-c2pa' | 'xmp-reference',
  bytes: number,
): ProvenanceSource {
  return {
    kind: 'credential',
    format: 'c2pa',
    container,
    bytes,
    outcome: 'unverifiable',
    validator: null,
    reason: 'credential container present; this build has no C2PA validator or trust policy',
  };
}

// --- XMP -------------------------------------------------------------------

/** The first XMP packet in the scanned prefix, or null. */
export function findXmpPacket(bytes: Buffer): string | null {
  const window = bytes.subarray(0, PROVENANCE_SCAN_LIMIT);
  const start = window.indexOf('<x:xmpmeta');
  if (start === -1) {
    const rdf = window.indexOf('<rdf:RDF');
    if (rdf === -1) return null;
    const rdfEnd = window.indexOf('</rdf:RDF>', rdf);
    return rdfEnd === -1 ? null : window.subarray(rdf, rdfEnd + '</rdf:RDF>'.length).toString('utf8');
  }
  const end = window.indexOf('</x:xmpmeta>', start);
  return end === -1 ? null : window.subarray(start, end + '</x:xmpmeta>'.length).toString('utf8');
}

/** Every value of a property, in element form, attribute form, or rdf:resource. */
function xmpValues(xml: string, localName: string): string[] {
  const values: string[] = [];
  for (const match of xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?${localName}\\b([^>]*)>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}>`, 'giu'))) {
    const resource = /\brdf:resource="([^"]*)"/u.exec(match[1] ?? '');
    const text = resource === null ? plainXmlText(match[2] ?? '') : (resource[1] ?? null);
    if (text !== null && text !== '') values.push(text);
  }
  for (const match of xml.matchAll(new RegExp(`\\b(?:[\\w.-]+:)?${localName}="([^"]*)"`, 'giu'))) {
    const text = plainXmlText(match[1] ?? '');
    if (text !== null && text !== '') values.push(text);
  }
  return values;
}

function digitalSourceClaim(value: string): ProvenanceClaim | null {
  const term = value.trim().split('/').pop() ?? '';
  return DIGITAL_SOURCE_CLAIMS[term] ?? null;
}

export function xmpSources(xml: string, origin: 'xmp' | 'xmp-sidecar'): ProvenanceSource[] {
  const sources: ProvenanceSource[] = [];
  const push = (source: ProvenanceSource | null): void => {
    if (source !== null) sources.push(source);
  };
  for (const value of xmpValues(xml, 'DigitalSourceType')) {
    const claim = digitalSourceClaim(value);
    if (claim !== null) push(declaration(origin, 'Iptc4xmpExt:DigitalSourceType', value, claim));
  }
  for (const value of xmpValues(xml, 'CreatorTool')) push(declaration(origin, 'xmp:CreatorTool', value, classifyTool(value)));
  for (const value of xmpValues(xml, 'softwareAgent')) {
    if (classifyTool(value) === 'generated') push(declaration(origin, 'xmpMM:History/stEvt:softwareAgent', value, 'edited'));
  }
  if (xmpValues(xml, 'provenance').length > 0) sources.push(credential('xmp-reference', 0));
  return sources;
}

// --- EXIF ------------------------------------------------------------------

async function exifSources(bytes: Buffer): Promise<ProvenanceSource[]> {
  try {
    const parsed = (await exifr.parse(bytes, { tiff: true, exif: false, gps: false, iptc: false, xmp: false, pick: ['Software'] })) as
      Record<string, unknown> | undefined;
    const software = parsed?.['Software'];
    if (typeof software !== 'string') return [];
    const source = declaration('exif', 'Software', software, classifyTool(software));
    return source === null ? [] : [source];
  } catch {
    return [];
  }
}

// --- JPEG ------------------------------------------------------------------

function jpegCredentialBytes(bytes: Buffer): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 0;
  let at = 2;
  let total = 0;
  let labeled = false;
  for (let segments = 0; segments < MAX_CHUNKS && at + 4 <= bytes.length; segments += 1) {
    if (bytes[at] !== 0xff) return 0;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const length = bytes.readUInt16BE(at + 2);
    if (length < 2) return 0;
    const payload = bytes.subarray(at + 4, at + 2 + length);
    if (
      marker === 0xeb &&
      payload.length >= 16 &&
      payload[0] === 0x4a &&
      payload[1] === 0x50 &&
      payload.subarray(12, 16).toString('latin1') === 'jumb'
    ) {
      total += payload.length;
      if (payload.indexOf('c2pa') !== -1) labeled = true;
    }
    at += 2 + length;
  }
  return labeled ? total : 0;
}

// --- PNG -------------------------------------------------------------------

function inflateBounded(data: Buffer): string | null {
  try {
    return inflateSync(data, { maxOutputLength: MAX_INFLATED }).toString('utf8');
  } catch {
    return null;
  }
}

function pngTextClaim(keyword: string, value: string): { readonly field: string; readonly claim: ProvenanceClaim } | null {
  switch (keyword) {
    case 'parameters':
      return { field: 'parameters', claim: 'generated' };
    case 'prompt':
    case 'workflow':
      return /"class_type"|"inputs"|"nodes"/u.test(value) ? { field: keyword, claim: 'generated' } : null;
    case 'Software':
    case 'Source':
      return { field: keyword, claim: classifyTool(value) };
    case 'Comment':
      return /novelai|"prompt"\s*:/iu.test(value) ? { field: 'Comment', claim: 'generated' } : null;
    default:
      return null;
  }
}

function pngSources(bytes: Buffer): ProvenanceSource[] {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return [];
  const sources: ProvenanceSource[] = [];
  let at = 8;
  for (let chunks = 0; chunks < MAX_CHUNKS && at + 8 <= bytes.length; chunks += 1) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString('latin1');
    const data = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + length));
    if (type === 'IEND') break;
    if (type === 'caBX') sources.push(credential('png-caBX', length));
    let keyword: string | null = null;
    let text: string | null = null;
    const zero = data.indexOf(0);
    if (zero > 0) {
      keyword = data.subarray(0, zero).toString('latin1');
      if (type === 'tEXt') text = data.subarray(zero + 1).toString('latin1');
      if (type === 'zTXt') text = inflateBounded(data.subarray(zero + 2));
      if (type === 'iTXt') {
        const compressed = data[zero + 1] === 1;
        const language = data.indexOf(0, zero + 3);
        const translated = language === -1 ? -1 : data.indexOf(0, language + 1);
        if (translated !== -1) {
          const body = data.subarray(translated + 1);
          text = compressed ? inflateBounded(body) : body.toString('utf8');
        }
      }
    }
    if (keyword !== null && text !== null) {
      const hit = pngTextClaim(keyword, text);
      if (hit !== null) {
        const source = declaration('png-text', hit.field, text, hit.claim);
        if (source !== null) sources.push(source);
      }
    }
    at += 12 + length;
  }
  return sources;
}

// --- ISO BMFF / WebP -------------------------------------------------------

function isoBmffCredentialBytes(bytes: Buffer): number {
  if (bytes.length < 12 || bytes.subarray(4, 8).toString('latin1') !== 'ftyp') return 0;
  let at = 0;
  let total = 0;
  for (let boxes = 0; boxes < MAX_CHUNKS && at + 8 <= bytes.length; boxes += 1) {
    let size = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString('latin1');
    let header = 8;
    if (size === 1 && at + 16 <= bytes.length) {
      size = Number(bytes.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = bytes.length - at;
    }
    if (size < header) return total;
    if (type === 'uuid' && at + header + 16 <= bytes.length && bytes.subarray(at + header, at + header + 16).equals(C2PA_UUID)) {
      total += size;
    }
    at += size;
  }
  return total;
}

function webpCredentialBytes(bytes: Buffer): number {
  if (bytes.length < 12 || bytes.subarray(0, 4).toString('latin1') !== 'RIFF' || bytes.subarray(8, 12).toString('latin1') !== 'WEBP')
    return 0;
  let at = 12;
  let total = 0;
  for (let chunks = 0; chunks < MAX_CHUNKS && at + 8 <= bytes.length; chunks += 1) {
    const fourcc = bytes.subarray(at, at + 4).toString('latin1');
    const size = bytes.readUInt32LE(at + 4);
    if (fourcc === 'C2PA') total += size;
    at += 8 + size + (size % 2);
  }
  return total;
}

// --- Entry point -----------------------------------------------------------

/** Every provenance source the bytes (and any XMP sidecars in custody)
 * declare or carry. Deterministic for identical input; bounded; never
 * throws on hostile data. */
export async function extractProvenanceSources(bytes: Buffer, sidecarXmp: readonly Buffer[] = []): Promise<readonly ProvenanceSource[]> {
  const sources: ProvenanceSource[] = [];
  const jpeg = jpegCredentialBytes(bytes);
  if (jpeg > 0) sources.push(credential('jpeg-app11', jpeg));
  const iso = isoBmffCredentialBytes(bytes);
  if (iso > 0) sources.push(credential('isobmff-uuid', iso));
  const webp = webpCredentialBytes(bytes);
  if (webp > 0) sources.push(credential('webp-c2pa', webp));
  sources.push(...pngSources(bytes));
  const packet = findXmpPacket(bytes);
  if (packet !== null) sources.push(...xmpSources(packet, 'xmp'));
  sources.push(...(await exifSources(bytes)));
  for (const sidecar of sidecarXmp) {
    const sidecarPacket = findXmpPacket(sidecar) ?? (sidecar.length <= PROVENANCE_SCAN_LIMIT ? sidecar.toString('utf8') : null);
    if (sidecarPacket !== null) sources.push(...xmpSources(sidecarPacket, 'xmp-sidecar'));
  }
  return dedupe(sources).slice(0, MAX_SOURCES);
}

function dedupe(sources: readonly ProvenanceSource[]): ProvenanceSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = JSON.stringify(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
