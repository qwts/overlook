// Library folder-name validation (#686). Conservative and identical on every
// platform: a library folder roams across volumes and operating systems
// (external disks, network shares, Windows ↔ macOS), so a name only counts as
// valid when every platform the disk might visit accepts it. Pure module —
// used by the renderer for live inline validation and re-checked in the main
// process before the engine runs.

export type FolderNameObjection =
  'empty' | 'dot-name' | 'separator' | 'forbidden-character' | 'reserved-name' | 'leading-space' | 'trailing-dot-or-space' | 'too-long';

/** Windows device names are invalid folder names even with an extension and
 * even on shares mounted from other platforms. */
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

// eslint-disable-next-line no-control-regex -- control characters are invalid in Windows filenames
const FORBIDDEN_CHARACTERS = /[<>:"|?*\u0000-\u001f]/u;

/** Longest folder name accepted everywhere: 255 bytes (UTF-8) covers APFS,
 * NTFS (255 UTF-16 units is wider), ext4, and exFAT. */
const MAX_NAME_BYTES = 255;

/** The reason `name` cannot be a library folder name, or null when valid. */
export function objectToFolderName(name: string): FolderNameObjection | null {
  if (name === '') return 'empty';
  if (name === '.' || name === '..') return 'dot-name';
  if (/[\\/]/u.test(name)) return 'separator';
  if (FORBIDDEN_CHARACTERS.test(name)) return 'forbidden-character';
  if (RESERVED_NAMES.test(name)) return 'reserved-name';
  if (/^\s/u.test(name)) return 'leading-space';
  if (/[. ]$/u.test(name)) return 'trailing-dot-or-space';
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return 'too-long';
  return null;
}

/** Human-readable objection for main-process refusal details; the renderer
 * renders its own localized copy per objection. */
export function describeFolderNameObjection(objection: FolderNameObjection): string {
  switch (objection) {
    case 'empty':
      return 'the folder name is empty';
    case 'dot-name':
      return '"." and ".." are not folder names';
    case 'separator':
      return 'folder names cannot contain path separators';
    case 'forbidden-character':
      return 'the name contains characters that are invalid on some platforms (< > : " | ? * or control characters)';
    case 'reserved-name':
      return 'the name is reserved by Windows (CON, PRN, AUX, NUL, COM1–9, LPT1–9)';
    case 'leading-space':
      return 'folder names cannot start with a space';
    case 'trailing-dot-or-space':
      return 'folder names cannot end with a dot or a space';
    case 'too-long':
      return 'the name is longer than 255 bytes';
  }
}
