import { normalizePhotoTags } from '../../shared/library/photo-metadata.js';

const MAX_XMP_BYTES = 5 * 1024 * 1024;

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

/** Bounded, non-validating XMP keyword projection. The original sidecar stays
 * authoritative and byte-identical in encrypted custody; malformed XML
 * simply contributes no searchable keywords. */
export function extractXmpKeywords(bytes: Buffer): string[] {
  if (bytes.length === 0 || bytes.length > MAX_XMP_BYTES) return [];
  const xml = bytes.toString('utf8');
  const subjectBlocks = [...xml.matchAll(/<(?:[\w.-]+:)?subject\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?subject>/giu)].map(
    (match) => match[1] ?? '',
  );
  const listItems = subjectBlocks.flatMap((block) =>
    [...block.matchAll(/<(?:[\w.-]+:)?li\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?li>/giu)].map((match) =>
      decodeXml((match[1] ?? '').replace(/<[^>]+>/gu, '').trim()),
    ),
  );
  const flatKeywords = [...xml.matchAll(/<(?:[\w.-]+:)?Keywords\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Keywords>/giu)].flatMap((match) =>
    decodeXml((match[1] ?? '').replace(/<[^>]+>/gu, '')).split(/[;,]/u),
  );
  return normalizePhotoTags([...listItems, ...flatKeywords].filter((value) => value.trim() !== ''));
}
