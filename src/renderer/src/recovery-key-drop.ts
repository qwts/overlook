export type RecoveryKeyDropFailure = 'empty' | 'multiple' | 'wrong-type' | 'unavailable';

export type RecoveryKeyDropAdmission =
  { readonly path: string; readonly reason: null } | { readonly path: null; readonly reason: RecoveryKeyDropFailure };

/**
 * Applies the renderer's immediate recovery-key drop UX checks. The main
 * process remains authoritative for exact file size, magic, version, and
 * authenticated decryption.
 */
export function admitRecoveryKeyDrop(files: FileList | readonly File[], pathForFile: (file: File) => string): RecoveryKeyDropAdmission {
  const dropped = Array.from(files);
  if (dropped.length === 0) return { path: null, reason: 'empty' };
  if (dropped.length !== 1) return { path: null, reason: 'multiple' };

  const file = dropped[0];
  if (file === undefined || !file.name.toLocaleLowerCase().endsWith('.key')) {
    return { path: null, reason: 'wrong-type' };
  }

  try {
    const path = pathForFile(file);
    return path === '' ? { path: null, reason: 'unavailable' } : { path, reason: null };
  } catch {
    return { path: null, reason: 'unavailable' };
  }
}
