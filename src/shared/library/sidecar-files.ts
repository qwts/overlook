// Sidecar companion policy (#484, ADR-0031 §1/§4). Photo workflows place
// metadata and edit instructions beside an original as sidecar files; Overlook
// imports the reviewed allowlist below into encrypted custody owned by the
// photo. The allowlist is deliberately explicit — arbitrary same-basename
// files are never accepted — and association is by exact stem in the same
// directory (`IMG_001.jpg` ↔ `IMG_001.xmp`), matched case-insensitively
// because camera vendors disagree about case (`IMG_001.XMP`).

/** Reviewed sidecar formats (v1): XMP metadata and Apple AAE edit recipes.
 * Additions need fixtures and documented association rules (#484 policy). */
export const SIDECAR_ROLES = ['xmp', 'aae'] as const;
export type SidecarRole = (typeof SIDECAR_ROLES)[number];

const ROLE_BY_EXTENSION: Readonly<Record<string, SidecarRole>> = {
  xmp: 'xmp',
  aae: 'aae',
};

/** The sidecar role for a file name, or null when it is not an allowlisted
 * sidecar. Hidden/AppleDouble names are never sidecars. */
export function classifySidecarFile(fileName: string): SidecarRole | null {
  if (fileName.startsWith('.')) return null;
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return null;
  return ROLE_BY_EXTENSION[fileName.slice(dot + 1).toLowerCase()] ?? null;
}

/** The association stem: file name without its final extension, lowercased
 * for the case-insensitive match. `IMG_001.jpg` and `IMG_001.XMP` share the
 * stem `img_001`. */
export function sidecarStem(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return (dot <= 0 ? fileName : fileName.slice(0, dot)).toLowerCase();
}
