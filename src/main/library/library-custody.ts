import type { LibraryCustodyState } from '../../shared/library/custody.js';
import { custodyErrorMessage, KeyCustodyError, KeyStore, probeMasterUnwrap, type SafeStorageLike } from '../crypto/keystore.js';
import { openWithLibraryLock } from './open-library-guard.js';

type CustodyBlock = { readonly dataDir: string; readonly state: Exclude<LibraryCustodyState, 'ok'> };

let block: CustodyBlock | null = null;

export function clearLibraryCustodyBlock(): void {
  block = null;
}

/** A failure stays cached for that library until a successful open or a
 * recovery-key import. Another library is probed. An open library is `ok`. */
export function readLibraryCustody(libraryOpen: boolean, dataDir: string, probe: () => LibraryCustodyState): LibraryCustodyState {
  if (libraryOpen) return 'ok';
  if (block !== null && block.dataDir === dataDir) return block.state;
  const probed = probe();
  if (probed !== 'ok') block = { dataDir, state: probed };
  return probed;
}

function rememberCustodyFailure(dataDir: string, error: unknown): void {
  if (!(error instanceof KeyCustodyError)) return;
  if (error.message === custodyErrorMessage('unwrap-failed')) block = { dataDir, state: 'unwrap-failed' };
  else if (error.message === custodyErrorMessage('malformed')) block = { dataDir, state: 'malformed' };
  else if (error.message === custodyErrorMessage('keychain-unavailable')) block = { dataDir, state: 'keychain-unavailable' };
}

/** The active library path, probed without healing or opening the database. */
export function readProbedLibraryCustody(libraryOpen: boolean, dataDir: string, safeStorage: SafeStorageLike): LibraryCustodyState {
  return readLibraryCustody(libraryOpen, dataDir, () => probeMasterUnwrap(safeStorage, dataDir));
}

/** Probe before taking the lock. A throw releases a lock acquired for this attempt. */
export function takeLibraryKeyStore(
  dataDir: string,
  instanceId: string,
  safeStorage: SafeStorageLike,
  releasedMaster: Buffer | undefined,
  heldRelease: (() => void) | undefined,
  acquire: (dataDir: string, instanceId: string) => () => void,
): { readonly keyStore: KeyStore; readonly release: () => void } {
  // App-lock unlock already released the master. `openWithMaster` does not
  // read `master.key`, so a missing keychain must not refuse that path.
  if (releasedMaster === undefined) {
    const probed = probeMasterUnwrap(safeStorage, dataDir);
    if (probed !== 'ok') {
      block = { dataDir, state: probed };
      throw new KeyCustodyError(custodyErrorMessage(probed));
    }
  }
  try {
    const opened = openWithLibraryLock({
      dataDir,
      instanceId,
      heldRelease,
      acquire,
      open: () =>
        releasedMaster === undefined
          ? KeyStore.open({ safeStorage, dataDir })
          : KeyStore.openWithMaster({ safeStorage, dataDir }, releasedMaster),
    });
    block = null;
    return { keyStore: opened.value, release: opened.release };
  } catch (error) {
    rememberCustodyFailure(dataDir, error);
    throw error;
  }
}
