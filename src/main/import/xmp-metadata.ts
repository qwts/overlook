import { normalizeImportedPhotoTags } from '../../shared/library/photo-metadata.js';

const MAX_XMP_BYTES = 5 * 1024 * 1024;

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

function plainXmlText(value: string): string | null {
  const trimmed = value.trim();
  return /[<>]/u.test(trimmed) ? null : decodeXml(trimmed);
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
    [...block.matchAll(/<(?:[\w.-]+:)?li\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?li>/giu)].flatMap((match) => {
      const text = plainXmlText(match[1] ?? '');
      return text === null ? [] : [text];
    }),
  );
  const flatKeywords = [...xml.matchAll(/<(?:[\w.-]+:)?Keywords\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Keywords>/giu)].flatMap(
    (match) => plainXmlText(match[1] ?? '')?.split(/[;,]/u) ?? [],
  );
  return normalizeImportedPhotoTags([...listItems, ...flatKeywords].filter((value) => value.trim() !== ''));
}
