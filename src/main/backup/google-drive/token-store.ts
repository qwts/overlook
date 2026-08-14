import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SafeStorageLike } from '../../crypto/keystore.js';

const AUTH_FILE = 'google-drive-auth.bin';

export class GoogleDriveCustodyError extends Error {
  override readonly name = 'GoogleDriveCustodyError';
}

export interface GoogleDriveAuthRecord {
  readonly clientId: string;
  readonly refreshToken: string;
  readonly connectedAt: string;
  /** Non-secret subject captured after OAuth; absent on legacy/provisional records. */
  readonly accountId?: string | undefined;
  readonly accountLabel?: string | undefined;
}

function isAuthRecord(value: unknown): value is GoogleDriveAuthRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const accountId = record['accountId'];
  const accountLabel = record['accountLabel'];
  const identityValid =
    (accountId === undefined && accountLabel === undefined) ||
    (typeof accountId === 'string' && accountId !== '' && typeof accountLabel === 'string' && accountLabel !== '');
  return (
    typeof record['clientId'] === 'string' &&
    record['clientId'].endsWith('.apps.googleusercontent.com') &&
    typeof record['refreshToken'] === 'string' &&
    record['refreshToken'] !== '' &&
    typeof record['connectedAt'] === 'string' &&
    identityValid
  );
}

export class GoogleDriveTokenStore {
  private readonly filePath: string;

  constructor(
    private readonly options: {
      readonly safeStorage: SafeStorageLike;
      readonly dataDir: string;
    },
  ) {
    this.filePath = join(options.dataDir, AUTH_FILE);
  }

  save(record: GoogleDriveAuthRecord): void {
    if (!this.options.safeStorage.isEncryptionAvailable()) {
      throw new GoogleDriveCustodyError('OS keychain encryption is unavailable; cannot store the Google Drive refresh token.');
    }
    mkdirSync(this.options.dataDir, { recursive: true });
    const staged = `${this.filePath}.tmp`;
    writeFileSync(staged, this.options.safeStorage.encryptString(JSON.stringify(record)));
    renameSync(staged, this.filePath);
  }

  load(): GoogleDriveAuthRecord | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const parsed: unknown = JSON.parse(this.options.safeStorage.decryptString(readFileSync(this.filePath)));
      return isAuthRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  clear(): void {
    rmSync(this.filePath, { force: true });
  }
}
