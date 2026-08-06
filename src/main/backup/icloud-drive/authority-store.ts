import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SafeStorageLike } from '../../crypto/keystore.js';
import type { ProviderAccountIdentity } from '../provider.js';

const AUTHORITY_FILE = 'icloud-drive-authority.bin';
const ACCOUNT_TOKEN = /^[a-f0-9]{16,128}$/u;

export type ICloudDriveAuthorityRecord = ProviderAccountIdentity;

function validRecord(value: unknown): value is ICloudDriveAuthorityRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['accountId'] === 'string' &&
    ACCOUNT_TOKEN.test(record['accountId']) &&
    typeof record['accountLabel'] === 'string' &&
    record['accountLabel'].trim() !== ''
  );
}

export class ICloudDriveAuthorityStore {
  private readonly filePath: string;

  constructor(
    private readonly safeStorage: SafeStorageLike,
    private readonly dataDir: string,
  ) {
    this.filePath = join(dataDir, AUTHORITY_FILE);
  }

  load(): string | null {
    return this.loadRecord()?.accountId ?? null;
  }

  loadRecord(): ICloudDriveAuthorityRecord | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const plaintext = this.safeStorage.decryptString(readFileSync(this.filePath));
      if (ACCOUNT_TOKEN.test(plaintext)) return { accountId: plaintext, accountLabel: 'iCloud account' };
      const parsed: unknown = JSON.parse(plaintext);
      return validRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  save(value: ICloudDriveAuthorityRecord | string): void {
    const record = typeof value === 'string' ? { accountId: value, accountLabel: 'iCloud account' } : value;
    if (!validRecord(record)) throw new Error('invalid iCloud account authority');
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('OS keychain encryption is unavailable');
    mkdirSync(this.dataDir, { recursive: true });
    const staged = `${this.filePath}.tmp`;
    writeFileSync(staged, this.safeStorage.encryptString(JSON.stringify(record)), { mode: 0o600 });
    renameSync(staged, this.filePath);
  }

  clear(): void {
    rmSync(this.filePath, { force: true });
  }
}
