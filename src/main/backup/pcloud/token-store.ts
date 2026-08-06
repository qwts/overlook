import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SafeStorageLike } from '../../crypto/keystore.js';
import type { PCloudApiHost } from './oauth.js';

// pCloud token custody (#254): the access token is credential material, so
// it gets the library keys' treatment — sealed by the OS keychain via
// safeStorage, written atomically, never logged. A record that fails to
// decrypt or parse reads as "not connected" rather than crashing: the user
// reconnects, which rewrites it.

const AUTH_FILE = 'pcloud-auth.bin';

export class PCloudCustodyError extends Error {
  override readonly name = 'PCloudCustodyError';
}

export interface PCloudAuthRecord {
  readonly accessToken: string;
  readonly apiHost: PCloudApiHost;
  readonly connectedAt: string;
  /** Non-secret subject captured after OAuth; absent on legacy/provisional records. */
  readonly accountId?: string | undefined;
  readonly accountLabel?: string | undefined;
}

function isAuthRecord(value: unknown): value is PCloudAuthRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const accountId = record['accountId'];
  const accountLabel = record['accountLabel'];
  const identityValid =
    (accountId === undefined && accountLabel === undefined) ||
    (typeof accountId === 'string' && accountId !== '' && typeof accountLabel === 'string' && accountLabel !== '');
  return (
    typeof record['accessToken'] === 'string' &&
    record['accessToken'] !== '' &&
    (record['apiHost'] === 'api.pcloud.com' || record['apiHost'] === 'eapi.pcloud.com') &&
    typeof record['connectedAt'] === 'string' &&
    identityValid
  );
}

export interface PCloudTokenStoreOptions {
  readonly safeStorage: SafeStorageLike;
  readonly dataDir: string;
}

export class PCloudTokenStore {
  private readonly safeStorage: SafeStorageLike;
  private readonly dataDir: string;
  private readonly filePath: string;

  constructor(options: PCloudTokenStoreOptions) {
    this.safeStorage = options.safeStorage;
    this.dataDir = options.dataDir;
    this.filePath = join(options.dataDir, AUTH_FILE);
  }

  save(record: PCloudAuthRecord): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new PCloudCustodyError('OS keychain encryption is unavailable; cannot store the pCloud token.');
    }
    mkdirSync(this.dataDir, { recursive: true });
    const sealed = this.safeStorage.encryptString(JSON.stringify(record));
    const staged = `${this.filePath}.tmp`;
    writeFileSync(staged, sealed);
    renameSync(staged, this.filePath);
  }

  load(): PCloudAuthRecord | null {
    if (!existsSync(this.filePath)) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(this.safeStorage.decryptString(readFileSync(this.filePath)));
      return isAuthRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  clear(): void {
    rmSync(this.filePath, { force: true });
  }
}
