import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import { ProviderError, type StorageProvider } from './provider.js';
import { createDecryptStream, EnvelopeError, type KeyResolver } from '../crypto/envelope.js';
import type { SyncStatus } from '../../shared/library/types.js';

export interface BackupIntegrityItem {
  readonly id: string;
  readonly contentHash: string;
  readonly syncState: Extract<SyncStatus, 'synced' | 'offloaded' | 'error'>;
}

export interface BackupIntegrityCursor {
  readonly version: 1;
  readonly afterId: string | null;
  readonly completedAt: string | null;
}

export interface BackupIntegritySummary {
  readonly checked: number;
  readonly repaired: number;
  readonly unrecoverable: number;
  readonly cycleComplete: boolean;
}

interface BackupIntegrityCursorStore {
  readonly load: () => Promise<BackupIntegrityCursor>;
  readonly save: (cursor: BackupIntegrityCursor) => Promise<void>;
}

export interface BackupIntegrityScrubberDeps {
  readonly provider: StorageProvider;
  readonly batchSize: number;
  readonly items: (page: { readonly afterId: string | null; readonly limit: number }) => readonly BackupIntegrityItem[];
  readonly hasLocal: (contentHash: string) => boolean;
  readonly encryptedStream: (contentHash: string) => Readable;
  readonly verifyRemoteCiphertext: (item: BackupIntegrityItem, ciphertext: Readable) => Promise<boolean>;
  readonly markUnrecoverable: (photoId: string) => void;
  readonly markVerified?: ((photoId: string) => void) | undefined;
  readonly cursor: BackupIntegrityCursorStore;
  readonly audit: (line: string) => void;
  readonly now: () => Date;
}

function blobPath(contentHash: string): string {
  return `blobs/${contentHash.slice(0, 2)}/${contentHash}`;
}

function isRemoteDamage(error: unknown): boolean {
  return error instanceof ProviderError && (error.kind === 'not-found' || error.kind === 'corrupt');
}

async function digest(stream: Readable): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const hasher = createHash('sha256');
  let bytes = 0;
  stream.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });
  await pipeline(stream, hasher);
  return { sha256: hasher.digest('hex'), bytes };
}

/** Authenticates a remote envelope and proves its plaintext content address
 * without ever writing plaintext to disk. */
export async function verifyRemoteOriginalCiphertext(
  item: BackupIntegrityItem,
  ciphertext: Readable,
  resolveKey: KeyResolver,
): Promise<boolean> {
  const hasher = createHash('sha256');
  try {
    await pipeline(ciphertext, createDecryptStream(resolveKey, { photoId: item.id }), hasher);
  } catch (error) {
    if (error instanceof EnvelopeError) {
      return false;
    }
    throw error;
  }
  return hasher.digest('hex') === item.contentHash;
}

/**
 * Walks a bounded slice of already-backed-up rows and proves their remote
 * ciphertext still exists. Local-backed damage is repaired from the original
 * encrypted envelope; remote-only damage fails closed and becomes actionable.
 */
export class BackupIntegrityScrubber {
  constructor(private readonly deps: BackupIntegrityScrubberDeps) {}

  async scrub(): Promise<BackupIntegritySummary> {
    const cursor = await this.deps.cursor.load();
    const items = this.deps.items({ afterId: cursor.afterId, limit: this.deps.batchSize });
    let repaired = 0;
    let unrecoverable = 0;

    for (const item of items) {
      if (this.deps.hasLocal(item.contentHash)) {
        repaired += await this.checkLocalBacked(item);
      } else {
        unrecoverable += await this.checkRemoteOnly(item);
      }
      await this.deps.cursor.save({ version: 1, afterId: item.id, completedAt: null });
    }

    const cycleComplete = items.length < this.deps.batchSize;
    if (cycleComplete) {
      await this.deps.cursor.save({ version: 1, afterId: null, completedAt: this.deps.now().toISOString() });
    }

    return { checked: items.length, repaired, unrecoverable, cycleComplete };
  }

  private async checkLocalBacked(item: BackupIntegrityItem): Promise<number> {
    const path = blobPath(item.contentHash);
    const local = await digest(this.deps.encryptedStream(item.contentHash));
    let damaged: boolean;
    try {
      const remote = await this.deps.provider.verify(path);
      damaged = remote.sha256 !== local.sha256 || remote.bytes !== local.bytes;
    } catch (error) {
      if (!isRemoteDamage(error)) {
        throw error;
      }
      damaged = true;
    }

    if (!damaged) {
      this.deps.markVerified?.(item.id);
      return 0;
    }

    await this.deps.provider.put(path, this.deps.encryptedStream(item.contentHash));
    const repaired = await this.deps.provider.verify(path);
    if (repaired.sha256 !== local.sha256 || repaired.bytes !== local.bytes) {
      throw new ProviderError(`integrity repair verification failed for ${item.id}`, 'corrupt');
    }
    this.deps.audit(`INTEGRITY-REPAIRED photo=${item.id} hash=${item.contentHash}`);
    this.deps.markVerified?.(item.id);
    return 1;
  }

  private async checkRemoteOnly(item: BackupIntegrityItem): Promise<number> {
    const path = blobPath(item.contentHash);
    let valid = false;
    try {
      valid = await this.deps.verifyRemoteCiphertext(item, await this.deps.provider.getStream(path));
    } catch (error) {
      if (!isRemoteDamage(error)) {
        throw error;
      }
    }
    if (valid) {
      this.deps.markVerified?.(item.id);
      return 0;
    }
    this.deps.markUnrecoverable(item.id);
    this.deps.audit(`INTEGRITY-UNRECOVERABLE photo=${item.id} hash=${item.contentHash}`);
    return 1;
  }
}
