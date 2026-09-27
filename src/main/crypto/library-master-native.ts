import { createRequire } from 'node:module';

import { OVERLOOK_LIBRARY_MASTER_SERVICE } from '../../shared/app-identity.js';
import { LibraryMasterBackupError, type LibraryMasterBackup, type LibraryMasterBackupCode } from './library-master-port.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const nativeRequire = createRequire(import.meta.url);

interface NativeStatus {
  readonly status?: unknown;
  readonly data?: unknown;
}

interface NativeBinding {
  write(service: string, account: string, secret: Buffer): unknown;
  read(service: string, account: string): unknown;
  remove(service: string, account: string): unknown;
}

export interface LibraryMasterNativeOptions {
  readonly platform: NodeJS.Platform;
  readonly loadBinding?: () => unknown;
}

function defaultLoadBinding(): unknown {
  return nativeRequire('@overlook/touch-id/library-master.cjs');
}

function isBinding(value: unknown): value is NativeBinding {
  if (typeof value !== 'object' || value === null) return false;
  const binding = value as Record<string, unknown>;
  return typeof binding['write'] === 'function' && typeof binding['read'] === 'function' && typeof binding['remove'] === 'function';
}

function statusOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const status = (value as NativeStatus).status;
  return typeof status === 'string' ? status : null;
}

function failureCode(status: string | null): LibraryMasterBackupCode {
  return status === 'denied' ? 'denied' : 'unavailable';
}

function requireAccount(libraryId: string): void {
  if (!ULID.test(libraryId)) throw new LibraryMasterBackupError('invalid-account');
}

const unavailableBackup: LibraryMasterBackup = {
  read(): string | null {
    throw new LibraryMasterBackupError('unavailable');
  },
  write(): void {
    throw new LibraryMasterBackupError('unavailable');
  },
  remove(): void {
    throw new LibraryMasterBackupError('unavailable');
  },
};

const noopBackup: LibraryMasterBackup = {
  read: () => null,
  write: () => undefined,
  remove: () => undefined,
};

function fromBinding(binding: NativeBinding): LibraryMasterBackup {
  const service = OVERLOOK_LIBRARY_MASTER_SERVICE;
  return {
    read(libraryId: string): string | null {
      requireAccount(libraryId);
      const result = binding.read(service, libraryId);
      const status = statusOf(result);
      if (status === 'absent') return null;
      if (status !== 'value' || !Buffer.isBuffer((result as NativeStatus).data)) {
        throw new LibraryMasterBackupError(failureCode(status));
      }
      return ((result as NativeStatus).data as Buffer).toString('utf8');
    },
    write(libraryId: string, canonicalBase64: string): void {
      requireAccount(libraryId);
      const secret = Buffer.from(canonicalBase64, 'utf8');
      try {
        const status = statusOf(binding.write(service, libraryId, secret));
        if (status !== 'stored') throw new LibraryMasterBackupError(failureCode(status));
      } finally {
        secret.fill(0);
      }
    },
    remove(libraryId: string): void {
      requireAccount(libraryId);
      const status = statusOf(binding.remove(service, libraryId));
      if (status !== 'stored') throw new LibraryMasterBackupError(failureCode(status));
    },
  };
}

/** macOS loads the in-process Keychain addon. Other platforms have no item, so delete is a no-op.
 * A darwin process whose addon did not load fails closed: a delete must not report the item gone. */
export function createLibraryMasterBackup(options: LibraryMasterNativeOptions): LibraryMasterBackup {
  if (options.platform !== 'darwin') return noopBackup;
  try {
    const loaded = (options.loadBinding ?? defaultLoadBinding)();
    if (!isBinding(loaded)) return unavailableBackup;
    return fromBinding(loaded);
  } catch {
    return unavailableBackup;
  }
}
