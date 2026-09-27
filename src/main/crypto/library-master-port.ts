import { readStoredLibraryId } from '../library/library-id.js';

export type LibraryMasterBackupCode = 'denied' | 'unavailable' | 'invalid-account';

export class LibraryMasterBackupError extends Error {
  override readonly name = 'LibraryMasterBackupError';

  constructor(readonly code: LibraryMasterBackupCode) {
    super(code);
  }
}

/** Same-Mac copy of one library master. `read` returns null when the item is absent. */
export interface LibraryMasterBackup {
  read(libraryId: string): string | null;
  write(libraryId: string, canonicalBase64: string): void;
  remove(libraryId: string): void;
}

const noopLibraryMasterBackup: LibraryMasterBackup = {
  read: () => null,
  write: () => undefined,
  remove: () => undefined,
};

let installed: LibraryMasterBackup = noopLibraryMasterBackup;

export function installedLibraryMasterBackup(): LibraryMasterBackup {
  return installed;
}

export function installLibraryMasterBackup(backup: LibraryMasterBackup): void {
  installed = backup;
}

/** Writes the item for this directory's ULID. A missing id skips the write. A failure
 * stays in the main process: the library is already open under the current Safe Storage password. */
export function rememberOpenedMaster(
  dataDir: string,
  masterKey: Buffer,
  backup: LibraryMasterBackup = installedLibraryMasterBackup(),
): void {
  const libraryId = readStoredLibraryId(dataDir);
  if (libraryId === null) return;
  try {
    backup.write(libraryId, masterKey.toString('base64'));
  } catch (error) {
    const code = error instanceof LibraryMasterBackupError ? error.code : 'unavailable';
    console.error('[overlook] library master backup write failed', code);
  }
}
