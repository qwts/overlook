import { readStoredLibraryId } from '../library/library-id.js';
import type { LibraryCustodyState } from '../../shared/library/custody.js';
import { probeMasterUnwrap, type SafeStorageLike } from './keystore.js';
import { installedLibraryMasterBackup, type LibraryMasterBackup } from './library-master-port.js';
import { installRecoveredMaster } from './recovery.js';

function canonicalMaster(value: string): Buffer | null {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) return null;
  return decoded;
}

/** Consults the login-keychain copy only after Safe Storage decrypt threw.
 * A denial, or a master that keys.json will not vouch for, leaves the file untouched. */
export function restoreUnwrappedMaster(safeStorage: SafeStorageLike, dataDir: string, backup: LibraryMasterBackup): LibraryCustodyState {
  const libraryId = readStoredLibraryId(dataDir);
  if (libraryId === null) return 'unwrap-failed';
  let stored: string | null;
  try {
    stored = backup.read(libraryId);
  } catch {
    return 'unwrap-failed';
  }
  if (stored === null) return 'unwrap-failed';
  const master = canonicalMaster(stored);
  if (master === null) return 'malformed';
  try {
    const installed = installRecoveredMaster(dataDir, safeStorage, master);
    return installed === 'installed' || installed === 'already-installed' ? 'ok' : 'unwrap-failed';
  } catch {
    return 'unwrap-failed';
  } finally {
    master.fill(0);
  }
}

export function probeLibraryCustody(
  safeStorage: SafeStorageLike,
  dataDir: string,
  backup: LibraryMasterBackup = installedLibraryMasterBackup(),
): LibraryCustodyState {
  const probed = probeMasterUnwrap(safeStorage, dataDir);
  if (probed !== 'unwrap-failed') return probed;
  return restoreUnwrappedMaster(safeStorage, dataDir, backup);
}
