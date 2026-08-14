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

export async function requireMoveImportConfirmation(
  mode: 'copy' | 'move',
  source: ImportMoveSource,
  confirmMove?: (source: ImportMoveSource) => Promise<boolean>,
): Promise<boolean> {
  if (mode !== 'move') return true;
  const paths = source.files ?? (source.path === undefined ? [] : [source.path]);
  if (paths.length === 0 || paths.some((candidate) => !isAbsoluteImportPath(candidate))) {
    throw new Error('Move import sources must use absolute paths');
  }
  return (await confirmMove?.(source)) === true;
}
