import { posix, win32 } from 'node:path';

export interface ImportMoveSource {
  readonly path?: string | undefined;
  readonly files?: readonly string[] | undefined;
}

export function isAbsoluteImportPath(candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return posix.isAbsolute(candidate);
  const root = win32.parse(candidate).root;
  return win32.isAbsolute(candidate) && root !== '\\' && root !== '/';
}

export function isCanonicalImportPath(candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!isAbsoluteImportPath(candidate, platform)) return false;
  const comparable = platform === 'win32' ? candidate.replaceAll('/', '\\') : candidate;
  return (platform === 'win32' ? win32 : posix).normalize(comparable) === comparable;
}

export async function requireMoveImportConfirmation(
  mode: 'copy' | 'move',
  source: ImportMoveSource,
  confirmMove?: (source: ImportMoveSource) => Promise<boolean>,
): Promise<boolean> {
  if (mode !== 'move') return true;
  const paths = source.files ?? (source.path === undefined ? [] : [source.path]);
  if (paths.length === 0 || paths.some((candidate) => !isCanonicalImportPath(candidate))) {
    throw new Error('Move import sources must use absolute paths without non-canonical segments');
  }
  return (await confirmMove?.(source)) === true;
}
