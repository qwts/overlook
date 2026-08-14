import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ICloudDriveNativeError,
  type ICloudDriveNativeBridge,
  type ICloudDriveNativeErrorCode,
} from '../backup/icloud-drive/native-bridge.js';
import type { ICloudNativeAuthority } from './icloud-native-host.js';
import { INTEROP_PROVIDER_LOGICAL_ROOT, InteropTransportError, assertSafeInteropPath } from './transport.js';

const PAGE_SIZE = 100;

export interface ICloudAccountAuthorityStore {
  load(): string | null;
  save(accountToken: string): void;
}

export interface ICloudNativeAuthorityOptions {
  readonly bridge: ICloudDriveNativeBridge;
  readonly accountAuthority: ICloudAccountAuthorityStore;
  readonly stagingDirectory: string;
}

function mappedError(error: unknown): InteropTransportError {
  const code: ICloudDriveNativeErrorCode | undefined = error instanceof ICloudDriveNativeError ? error.code : undefined;
  if (code === 'account-changed' || code === 'account-unavailable' || code === 'unentitled')
    return new InteropTransportError('iCloud account authority is unavailable.', 'auth-expired', false);
  if (code === 'offline' || code === 'materialization-delayed')
    return new InteropTransportError('iCloud is temporarily offline.', 'offline', true);
  if (code === 'not-found') return new InteropTransportError('iCloud object was not found.', 'not-found', false);
  if (code === 'conflict') return new InteropTransportError('iCloud object is conflicted.', 'corrupt', false);
  if (code === 'invalid-path') return new InteropTransportError('iCloud object path is invalid.', 'corrupt', false);
  return new InteropTransportError('iCloud native bridge is unavailable.', 'provider-unavailable', true);
}

function remotePath(path: string): string {
  return `${INTEROP_PROVIDER_LOGICAL_ROOT}/${assertSafeInteropPath(path)}`;
}

function stagingPath(root: string, reference: string): string {
  return join(root, `${reference}.bin`);
}

async function digestFile(path: string): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { sha256: hash.digest('hex'), bytes: (await stat(path)).size };
}

/** Adapts the signed iCloud file bridge to ADR-0016's narrow native-host
 * authority. File references are opaque names inside an app-owned staging
 * directory; callers cannot supply filesystem paths. */
export class BridgeICloudNativeAuthority implements ICloudNativeAuthority {
  constructor(private readonly options: ICloudNativeAuthorityOptions) {}

  async status(): Promise<unknown> {
    const status = await this.bridgeStatus();
    await this.accountToken(status.accountToken);
    return { available: true, provider: 'icloud' };
  }

  async putFile(path: string, sourceFile: string): Promise<unknown> {
    try {
      const source = stagingPath(this.options.stagingDirectory, sourceFile);
      const info = await lstat(source).catch(() => {
        throw new InteropTransportError('Invalid encrypted staging file.', 'corrupt', false);
      });
      if (!info.isFile() || info.isSymbolicLink()) throw new InteropTransportError('Invalid encrypted staging file.', 'corrupt', false);
      await this.options.bridge.replaceFile(remotePath(path), source, await this.accountToken());
      return { stored: true };
    } catch (error) {
      if (error instanceof InteropTransportError) throw error;
      throw mappedError(error);
    }
  }

  async materializeFile(path: string, destinationFile: string): Promise<unknown> {
    try {
      await mkdir(this.options.stagingDirectory, { recursive: true, mode: 0o700 });
      const destination = stagingPath(this.options.stagingDirectory, destinationFile);
      await this.options.bridge.materializeFile(remotePath(path), destination, await this.accountToken());
      return { materialized: true, fileReference: destinationFile };
    } catch (error) {
      if (error instanceof InteropTransportError) throw error;
      throw mappedError(error);
    }
  }

  async list(path: string, cursor: string | null): Promise<unknown> {
    try {
      const prefix = remotePath(path);
      const page = await this.options.bridge.list(prefix, cursor, PAGE_SIZE, await this.accountToken());
      const expected = this.options.accountAuthority.load();
      if (expected === null || page.accountToken !== expected)
        throw new InteropTransportError('iCloud account authority changed.', 'auth-expired', false);
      const rootPrefix = `${INTEROP_PROVIDER_LOGICAL_ROOT}/`;
      if (page.entries.some((entry) => !entry.path.startsWith(rootPrefix)))
        throw new InteropTransportError('iCloud returned an object outside the interop namespace.', 'corrupt', false);
      return {
        entries: page.entries.map((entry) => ({
          path: entry.path.slice(rootPrefix.length),
          bytes: entry.size,
          modifiedAt: entry.modifiedAt,
          downloaded: entry.downloaded,
          conflicted: entry.conflicted,
        })),
        nextCursor: page.nextCursor,
      };
    } catch (error) {
      if (error instanceof InteropTransportError) throw error;
      throw mappedError(error);
    }
  }

  async delete(path: string): Promise<unknown> {
    try {
      await this.options.bridge.delete(remotePath(path), await this.accountToken());
      return { deleted: true };
    } catch (error) {
      if (error instanceof InteropTransportError) throw error;
      throw mappedError(error);
    }
  }

  async quota(): Promise<unknown> {
    await this.accountToken();
    return { usedBytes: 0, totalBytes: null };
  }

  async verify(path: string): Promise<unknown> {
    await mkdir(this.options.stagingDirectory, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.options.stagingDirectory, 'verify-'));
    const destination = join(directory, 'ciphertext.bin');
    try {
      await this.options.bridge.materializeFile(remotePath(path), destination, await this.accountToken());
      return await digestFile(destination);
    } catch (error) {
      if (error instanceof InteropTransportError) throw error;
      throw mappedError(error);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async bridgeStatus(): Promise<{ readonly accountToken: string }> {
    try {
      const status = await this.options.bridge.status();
      if (!status.available || status.accountToken === null)
        throw new InteropTransportError('iCloud native bridge is unavailable.', 'provider-unavailable', true);
      return { accountToken: status.accountToken };
    } catch (error) {
      if (error instanceof InteropTransportError) throw error;
      throw mappedError(error);
    }
  }

  private async accountToken(known?: string): Promise<string> {
    const current = known ?? (await this.bridgeStatus()).accountToken;
    const expected = this.options.accountAuthority.load();
    if (expected === null) this.options.accountAuthority.save(current);
    else if (expected !== current) throw new InteropTransportError('iCloud account authority changed.', 'auth-expired', false);
    return current;
  }
}
