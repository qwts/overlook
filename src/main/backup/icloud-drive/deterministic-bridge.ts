import { readFile, writeFile } from 'node:fs/promises';

import {
  ICloudDriveNativeError,
  type ICloudDriveNativeBridge,
  type ICloudDriveNativeEntry,
  type ICloudDriveNativeListPage,
  type ICloudDriveNativeStatus,
} from './native-bridge.js';

const DEFAULT_ACCOUNT = '0123456789abcdef';

export type DeterministicICloudFault = 'offline' | 'materialization-delayed' | 'conflict' | 'account-changed' | 'interrupt-after-replace';

interface StoredObject {
  readonly bytes: Buffer;
  readonly modifiedAt: string;
  downloaded: boolean;
  conflicted: boolean;
}

/** A deterministic local authority for shared provider and recovery contracts.
 * It models committed replacement separately from materialization and can be
 * reused by a new provider instance to exercise process restart behavior. */
export class DeterministicICloudDriveBridge implements ICloudDriveNativeBridge {
  readonly objects = new Map<string, StoredObject>();
  readonly calls: string[] = [];
  private fault: DeterministicICloudFault | null = null;
  private available = true;
  private accountToken = DEFAULT_ACCOUNT;
  private clock = 0;

  drain(): Promise<void> {
    return Promise.resolve();
  }

  arm(fault: DeterministicICloudFault): void {
    this.fault = fault;
  }

  disarm(): void {
    this.fault = null;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }

  changeAccount(accountToken = 'fedcba9876543210'): void {
    this.accountToken = accountToken;
  }

  setDownloaded(path: string, downloaded: boolean): void {
    const object = this.objects.get(path);
    if (object !== undefined) object.downloaded = downloaded;
  }

  setConflicted(path: string, conflicted: boolean): void {
    const object = this.objects.get(path);
    if (object !== undefined) object.conflicted = conflicted;
  }

  status(): Promise<ICloudDriveNativeStatus> {
    this.calls.push('status');
    if (!this.available) {
      return Promise.resolve({ available: false, reason: 'account-unavailable', accountToken: null, accountLabel: null });
    }
    return Promise.resolve({
      available: true,
      reason: null,
      accountToken: this.accountToken,
      accountLabel: 'Deterministic iCloud account',
    });
  }

  async replaceFile(path: string, sourceFile: string, accountToken: string): Promise<void> {
    this.calls.push(`replace:${path}`);
    this.check(accountToken, 'replace');
    const bytes = await readFile(sourceFile);
    this.clock += 1;
    this.objects.set(path, {
      bytes,
      modifiedAt: new Date(Date.UTC(2026, 6, 21, 0, 0, this.clock)).toISOString(),
      downloaded: true,
      conflicted: this.fault === 'conflict',
    });
    if (this.fault === 'conflict') throw new ICloudDriveNativeError('conflict');
    if (this.fault === 'interrupt-after-replace') throw new ICloudDriveNativeError('io-failure');
  }

  async materializeFile(path: string, destinationFile: string, accountToken: string): Promise<void> {
    this.calls.push(`materialize:${path}`);
    this.check(accountToken, 'materialize');
    const object = this.objects.get(path);
    if (object === undefined) throw new ICloudDriveNativeError('not-found');
    if (this.fault === 'materialization-delayed' || !object.downloaded) {
      throw new ICloudDriveNativeError('materialization-delayed');
    }
    if (this.fault === 'conflict' || object.conflicted) throw new ICloudDriveNativeError('conflict');
    await writeFile(destinationFile, object.bytes, { flag: 'wx', mode: 0o600 });
  }

  list(path: string, cursor: string | null, limit: number, accountToken: string): Promise<ICloudDriveNativeListPage> {
    this.calls.push(`list:${path}:${cursor ?? 'start'}`);
    this.check(accountToken, 'list');
    const offset = Number(cursor ?? '0');
    const entries = [...this.objects.entries()]
      .filter(([candidate]) => candidate.startsWith(`${path}/`))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([candidate, object]): ICloudDriveNativeEntry => ({
        path: candidate,
        size: object.bytes.length,
        modifiedAt: object.modifiedAt,
        downloaded: object.downloaded,
        conflicted: object.conflicted,
      }));
    const page = entries.slice(offset, offset + limit);
    const next = offset + page.length;
    return Promise.resolve({ entries: page, nextCursor: next < entries.length ? String(next) : null, accountToken: this.accountToken });
  }

  delete(path: string, accountToken: string): Promise<void> {
    this.calls.push(`delete:${path}`);
    this.check(accountToken, 'delete');
    this.objects.delete(path);
    return Promise.resolve();
  }

  private check(accountToken: string, operation: string): void {
    if (!this.available) throw new ICloudDriveNativeError('account-unavailable');
    if (accountToken !== this.accountToken || this.fault === 'account-changed') throw new ICloudDriveNativeError('account-changed');
    if (this.fault === 'offline') throw new ICloudDriveNativeError('offline');
    if (this.fault === 'conflict' && operation !== 'replace') throw new ICloudDriveNativeError('conflict');
  }
}
