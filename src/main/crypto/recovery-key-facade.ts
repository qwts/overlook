import { readFile, rename, stat, writeFile } from 'node:fs/promises';

import type { KeyStore, SafeStorageLike } from './keystore.js';
import {
  RECOVERY_FILE_LENGTH,
  fingerprintOf,
  installRecoveredMaster,
  openRecoveryKey,
  RecoveryError,
  sealRecoveryKey,
} from './recovery.js';

export async function readRecoveryKeyFile(importPath: string): Promise<Buffer> {
  const stats = await stat(importPath);
  if (!stats.isFile() || stats.size !== RECOVERY_FILE_LENGTH) throw new RecoveryError('invalid');
  return readFile(importPath);
}

export interface RecoveryKeyFacadeOptions {
  readonly keyStore: () => KeyStore;
  readonly safeStorage: () => SafeStorageLike;
  readonly dataDir: () => string;
  readonly pickExportDestination: () => Promise<string | null>;
  readonly pickImportSource: () => Promise<string | null>;
  readonly allowImport: () => boolean;
  readonly onExported?: (() => void) | undefined;
}

export function createRecoveryKeyFacade(options: RecoveryKeyFacadeOptions) {
  return {
    fingerprint: () => fingerprintOf(options.keyStore().masterKeyBytes()),
    exportKey: async (password: string) => {
      const destination = await options.pickExportDestination();
      if (destination === null) return null;
      const temporary = `${destination}.tmp`;
      await writeFile(temporary, sealRecoveryKey(options.keyStore().masterKeyBytes(), password));
      await rename(temporary, destination);
      options.onExported?.();
      return destination;
    },
    pickFile: options.pickImportSource,
    importKey: async (importPath: string, password: string) => {
      if (!options.allowImport()) {
        throw new Error('recovery-key import is unavailable while app lock is configured');
      }
      let data: Buffer;
      try {
        data = await readRecoveryKeyFile(importPath);
      } catch {
        return { installed: false, fingerprint: null, reason: 'invalid' as const };
      }
      try {
        const master = openRecoveryKey(data, password);
        const result = installRecoveredMaster(options.dataDir(), options.safeStorage(), master);
        if (result === 'mismatch' || result === 'no-library') {
          return { installed: false, fingerprint: null, reason: result };
        }
        return { installed: true, fingerprint: fingerprintOf(master), reason: null };
      } catch (error) {
        const reason = error instanceof RecoveryError ? error.reason : ('invalid' as const);
        return { installed: false, fingerprint: null, reason };
      }
    },
  };
}
