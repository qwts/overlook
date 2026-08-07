import exifr from 'exifr';

import { embeddedJpegFromRaf } from './raf-preview.js';
import { resolveRawPreview } from './raw-preview.js';
import { displayDimensions } from './display-dimensions.js';
import type { FileKind } from '../../shared/library/types.js';
import { normalizeImportedPhotoTags } from '../../shared/library/photo-metadata.js';

// EXIF extraction (#85) per ADR-0006's field set, robust to weird files:
// missing or corrupt metadata degrades to an all-null record — the import
// engine (#87) composes file-level facts around it. NEVER fabricate a value
// (interop rule): anything the file doesn't state is null.

export interface ExtractedMetadata {
  readonly width: number | null;
  readonly height: number | null;
  readonly camera: string | null;
  readonly lens: string | null;
  readonly iso: number | null;
  /** Formatted like the mock's aperture strings: "1.4". */
  readonly aperture: string | null;
  /** Formatted like the mock's shutter strings: "1/250". */
  readonly shutter: string | null;
  readonly focalLength: number | null;
  /**
   * ISO 8601 *floating* local time (no offset/Z), from DateTimeOriginal.
   * EXIF timestamps are wall-clock digits with no timezone — they are
   * persisted verbatim so the value never depends on the importer's zone.
   */
  readonly takenAt: string | null;
  readonly gpsLat: number | null;
  readonly gpsLon: number | null;
  /** IPTC/XMP keyword provenance; authored tags remain separate (#508). */
  readonly keywords?: readonly string[] | undefined;
}

const EMPTY: ExtractedMetadata = {
  width: null,
  height: null,
  camera: null,
  lens: null,
  iso: null,
  aperture: null,
  shutter: null,
  focalLength: null,
  takenAt: null,
  gpsLat: null,
  gpsLon: null,
};

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function formatAperture(fNumber: number | null): string | null {
  if (fNumber === null || fNumber <= 0) {
    return null;
  }
  return String(Math.round(fNumber * 10) / 10);
}

function formatShutter(exposureSeconds: number | null): string | null {
  if (exposureSeconds === null || exposureSeconds <= 0) {
    return null;
  }
  if (exposureSeconds < 1) {
    return `1/${String(Math.round(1 / exposureSeconds))}`;
  }
  return `${String(Math.round(exposureSeconds * 10) / 10)}s`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function asFloatingIsoDate(value: unknown): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return null;
  }
  // exifr revives the (timezone-less) EXIF digits as a Date in the current
  // process timezone, so the Date's *local* components are the file's
  // original digits. Serialize those — never toISOString(), which would
  // shift the stored value by the importer's UTC offset.
  return `${String(value.getFullYear())}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}T${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`;
}

/**
 * Extracts the ADR-0006 field set from a media file's bytes. RAF containers
 * are detected by magic (not extension) and resolve to their embedded JPEG
 * first. Any parse failure returns the all-null record.
 */
async function parseMetadata(bytes: Buffer): Promise<Record<string, unknown> | undefined> {
  try {
    return (await exifr.parse(bytes, { tiff: true, exif: true, gps: true, iptc: true, xmp: true })) as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}

function metadataKeywords(parsed: Readonly<Record<string, unknown>>): string[] {
  const values = ['Keywords', 'Subject', 'HierarchicalSubject', 'XPKeywords'].flatMap((key) => {
    const value = parsed[key];
    if (typeof value === 'string') return value.split(/[;,]/u);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  });
  return normalizeImportedPhotoTags(values.filter((value) => value.trim() !== ''));
}

export async function extractMetadata(bytes: Buffer, kind?: FileKind): Promise<ExtractedMetadata> {
  let parsed = await parseMetadata(bytes);
  let previewDimensions: { readonly width: number; readonly height: number } | null = null;
  const raw = kind === 'raw' || embeddedJpegFromRaf(bytes) !== null;
  if (raw) {
    const preview = await resolveRawPreview(bytes);
    if (preview !== null) {
      try {
        previewDimensions = { width: preview.width, height: preview.height };
        const previewMetadata = await parseMetadata(preview.bytes);
        // Container metadata is authoritative; the preview fills only fields
        // the RAW parser could not expose.
        parsed = { ...(previewMetadata ?? {}), ...(parsed ?? {}) };
      } finally {
        preview.bytes.fill(0);
      }
    }
  }
  if (parsed === undefined || parsed === null) {
    return previewDimensions === null ? EMPTY : { ...EMPTY, ...previewDimensions };
  }
  const make = asText(parsed['Make']);
  const model = asText(parsed['Model']);
  const metadataDimensions =
    displayDimensions(parsed['ExifImageWidth'], parsed['ExifImageHeight'], parsed['Orientation']) ??
    displayDimensions(parsed['ImageWidth'], parsed['ImageHeight'], parsed['Orientation']);
  return {
    width: metadataDimensions?.width ?? previewDimensions?.width ?? null,
    height: metadataDimensions?.height ?? previewDimensions?.height ?? null,
    // The mock's camera strings read "FUJIFILM X-T5" — make + model, deduped
    // when the model already leads with the make.
    camera: model === null ? make : make === null || model.toUpperCase().startsWith(make.toUpperCase()) ? model : `${make} ${model}`,
    lens: asText(parsed['LensModel']),
    iso: asFiniteNumber(parsed['ISO']),
    aperture: formatAperture(asFiniteNumber(parsed['FNumber'])),
    shutter: formatShutter(asFiniteNumber(parsed['ExposureTime'])),
    focalLength: asFiniteNumber(parsed['FocalLength']),
    takenAt: asFloatingIsoDate(parsed['DateTimeOriginal']) ?? asFloatingIsoDate(parsed['CreateDate']),
    gpsLat: asFiniteNumber(parsed['latitude']),
    gpsLon: asFiniteNumber(parsed['longitude']),
    keywords: metadataKeywords(parsed),
  };
}
