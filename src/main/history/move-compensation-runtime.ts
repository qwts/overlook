import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream, createWriteStream, existsSync, statfsSync, statSync } from 'node:fs';
import { access, link, open, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { BlobStore } from '../blobs/blob-store.js';
import type { KeyResolver } from '../crypto/envelope.js';
import { syncDirectoryEntry } from '../filesystem/durability.js';
import type { CapabilityReason } from '../../shared/history/types.js';
import type { MoveCompensationRuntime } from './history-service.js';

export class MoveCompensationError extends Error {
  override readonly name = 'MoveCompensationError';

  constructor(readonly reason: CapabilityReason) {
    super(`Move compensation is unavailable: ${reason}`);
  }
}

function errno(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function identity(path: string): string {
  const info = statSync(path);
  return `${info.dev}:${info.ino}`;
}

function availableBytes(path: string): number {
  const info = statfsSync(path);
  return info.bavail * info.bsize;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function closeHandle(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    if (errno(error) !== 'EBADF') throw error;
  }
}

export function createMoveCompensationRuntime(blobs: BlobStore, resolveKey: KeyResolver): MoveCompensationRuntime {
  return {
    capability(record) {
      if (record.sourcePath === '') return 'expired';
      if (!blobs.hasOriginal(record.contentHash)) return 'bytes-unavailable';
      const parent = dirname(record.sourcePath);
      try {
        if (identity(parent) !== record.parentIdentity) return 'state-changed';
        if (existsSync(record.sourcePath)) return 'path-occupied';
        if (availableBytes(parent) < record.byteCharge) return 'insufficient-space';
        statSync(parent, { throwIfNoEntry: true });
        return 'ready';
      } catch (error) {
        if (errno(error) === 'EACCES' || errno(error) === 'EPERM') return 'permission-denied';
        return 'resource-missing';
      }
    },
    async restore(record) {
      const parent = dirname(record.sourcePath);
      if (existsSync(record.sourcePath)) {
        if ((await hashFile(record.sourcePath)) === record.contentHash) return 'already-restored';
        throw new MoveCompensationError('path-occupied');
      }
      if (identity(parent) !== record.parentIdentity) throw new MoveCompensationError('state-changed');
      if (availableBytes(parent) < record.byteCharge) throw new MoveCompensationError('insufficient-space');
      try {
        await access(parent, constants.W_OK);
      } catch {
        throw new MoveCompensationError('permission-denied');
      }

      const stage = join(parent, `.${basename(record.sourcePath)}.overlook-undo-${randomBytes(8).toString('hex')}`);
      const hash = createHash('sha256');
      const hasher = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const handle = await open(stage, 'wx', 0o600);
      try {
        try {
          await pipeline(
            blobs.getStream(record.contentHash, resolveKey, record.photoId),
            hasher,
            createWriteStream(stage, { fd: handle.fd, autoClose: false }),
          );
          await handle.sync();
        } finally {
          await closeHandle(handle);
        }
        if (hash.digest('hex') !== record.contentHash) throw new MoveCompensationError('bytes-unavailable');
        if (identity(parent) !== record.parentIdentity) throw new MoveCompensationError('state-changed');
        try {
          await link(stage, record.sourcePath);
        } catch (error) {
          if (errno(error) !== 'EEXIST') throw error;
          if ((await hashFile(record.sourcePath)) === record.contentHash) return 'already-restored';
          throw new MoveCompensationError('path-occupied');
        }
        await syncDirectoryEntry(parent);
        return 'restored';
      } finally {
        await rm(stage, { force: true });
      }
    },
  };
}
