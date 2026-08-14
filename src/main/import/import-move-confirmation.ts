import { isAbsolute } from 'node:path';

export interface ImportMoveSource {
  readonly path?: string | undefined;
  readonly files?: readonly string[] | undefined;
}

export async function requireMoveImportConfirmation(
  mode: 'copy' | 'move',
  source: ImportMoveSource,
  confirmMove?: (source: ImportMoveSource) => Promise<boolean>,
): Promise<boolean> {
  if (mode !== 'move') return true;
  const paths = source.files ?? (source.path === undefined ? [] : [source.path]);
  if (paths.length === 0 || paths.some((candidate) => !isAbsolute(candidate))) {
    throw new Error('Move import sources must use absolute paths');
  }
  return (await confirmMove?.(source)) === true;
}
