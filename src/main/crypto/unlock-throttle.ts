import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import type { SafeStorageLike } from './keystore.js';

const FILE = 'app-lock-throttle';
const DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000] as const;

const throttleSchema = z
  .object({
    version: z.literal(1),
    failures: z.number().int().positive(),
    notBefore: z.number().int().nonnegative(),
  })
  .strict();

type ThrottleRecord = z.output<typeof throttleSchema>;

export interface UnlockThrottleOptions {
  readonly dataDir: string;
  readonly safeStorage: SafeStorageLike;
  readonly now?: () => number;
}

function atomicWrite(path: string, bytes: Buffer): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
}

export class UnlockThrottle {
  private readonly path: string;

  constructor(private readonly options: UnlockThrottleOptions) {
    this.path = join(options.dataDir, FILE);
  }

  remainingMs(): number {
    const record = this.read();
    if (record === null) return 0;
    return Math.max(0, record.notBefore - this.now());
  }

  failureCount(): number {
    return this.read()?.failures ?? 0;
  }

  attemptsRemaining(limit = 3): number {
    return Math.max(0, limit - this.failureCount());
  }

  recordFailure(): number {
    const previous = this.read();
    const failures = Math.min((previous?.failures ?? 0) + 1, DELAYS_MS.length);
    const delay = DELAYS_MS[failures - 1] ?? DELAYS_MS.at(-1) ?? 60_000;
    this.write({ version: 1, failures, notBefore: this.now() + delay });
    return delay;
  }

  reset(): void {
    rmSync(this.path, { force: true });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private read(): ThrottleRecord | null {
    if (!existsSync(this.path)) return null;
    try {
      const json = this.options.safeStorage.decryptString(readFileSync(this.path));
      const parsed = throttleSchema.parse(JSON.parse(json) as unknown);
      if (JSON.stringify(parsed) !== json) throw new Error('non-canonical throttle record');
      return parsed;
    } catch {
      const failedClosed = { version: 1 as const, failures: DELAYS_MS.length, notBefore: this.now() + 60_000 };
      this.write(failedClosed);
      return failedClosed;
    }
  }

  private write(record: ThrottleRecord): void {
    if (!this.options.safeStorage.isEncryptionAvailable()) throw new Error('OS keychain is unavailable');
    mkdirSync(this.options.dataDir, { recursive: true });
    atomicWrite(this.path, this.options.safeStorage.encryptString(JSON.stringify(record)));
  }
}
