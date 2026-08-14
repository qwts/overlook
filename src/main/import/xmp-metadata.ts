import { normalizeImportedPhotoTags } from '../../shared/library/photo-metadata.js';

const MAX_XMP_BYTES = 5 * 1024 * 1024;

function decodeXml(value: string): string {
  return value
    .replace(/&#(?:x([0-9A-Fa-f]{1,6})|([0-9]{1,7}));/gu, (entity, hex: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? decimal ?? '', hex === undefined ? 10 : 16);
      return codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff) ? String.fromCodePoint(codePoint) : entity;
    })
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
