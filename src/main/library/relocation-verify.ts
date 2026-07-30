import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { KeyStore, type SafeStorageLike } from '../crypto/keystore.js';
import { openLibraryDatabase } from '../db/database.js';
import { RelocationError } from './relocation-engine.js';

// Staged-library health check (ADR-0022 §4 step 3, #483): after byte digests
// verify, the staged database must open with the EXISTING custody. Missing
// custody files are a failed copy — KeyStore.open would mint fresh keys into
// them, so refuse before probing (never turn a bad copy into a "library").
//
// App-locked libraries (ADR-0013: master.key is an OVLK record) cannot be
// probed without the password: teardown zeroed the released master, and
// carrying it through a long copy would violate lock semantics, so the open
// probe is SKIPPED for OVLK custody (PR #553 review). That skip is honest —
// the digest pass already proved every custody byte identical to a library
// that opened, and the probe is belt-and-suspenders, not the verification.

const CUSTODY_FILES = ['master.key', 'keys.json', 'library.db'] as const;
const APP_LOCK_MAGIC = 'OVLK';

export function hasAppLockCustody(dir: string): boolean {
  const masterKeyPath = path.join(dir, 'master.key');
  return existsSync(masterKeyPath) && readFileSync(masterKeyPath).subarray(0, 4).toString('ascii') === APP_LOCK_MAGIC;
}

export function verifyStagedLibrary(safeStorage: () => SafeStorageLike, dir: string): Promise<void> {
  for (const rel of CUSTODY_FILES) {
    if (!existsSync(path.join(dir, rel))) {
      return Promise.reject(new RelocationError('verification-failed', `staged library is missing ${rel}`));
    }
  }
  if (hasAppLockCustody(dir)) {
    return Promise.resolve();
  }
  try {
    const keyStore = KeyStore.open({ safeStorage: safeStorage(), dataDir: dir });
    try {
      const dbKey = keyStore.resolver()(1);
      if (dbKey === undefined) throw new RelocationError('verification-failed', 'staged key store has no KEY #1');
      const db = openLibraryDatabase({ path: path.join(dir, 'library.db'), dbKey });
      db.close();
    } finally {
      keyStore.close();
    }
  } catch (error) {
    return Promise.reject(
      error instanceof RelocationError
        ? error
        : new RelocationError(
            'verification-failed',
            `staged library failed to open with existing custody: ${error instanceof Error ? error.message : String(error)}`,
          ),
    );
  }
  return Promise.resolve();
}
