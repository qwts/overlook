import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';

import { OVERLOOK_ICLOUD_CONTAINER_ID, OVERLOOK_MAC_BUNDLE_ID } from '../../../shared/app-identity.js';
import { CustodyWorkTracker } from '../../crypto/library-shutdown.js';

const nativeRequire = createRequire(import.meta.url);
const RELATIVE_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const ACCOUNT_TOKEN = /^[a-f0-9]{16,128}$/u;
const CURSOR = /^[0-9]+$/u;
const MAX_PAGE_SIZE = 1_000;

export type ICloudDriveUnavailableReason =
  'unsupported-platform' | 'unsigned-build' | 'native-unavailable' | 'unentitled' | 'account-unavailable';

export type ICloudDriveNativeErrorCode =
  | 'unavailable'
  | 'unentitled'
  | 'account-unavailable'
  | 'account-changed'
  | 'offline'
  | 'materialization-delayed'
  | 'conflict'
  | 'not-found'
  | 'invalid-path'
  | 'io-failure';

export interface ICloudDriveNativeStatus {
  readonly available: boolean;
  readonly reason: ICloudDriveUnavailableReason | null;
  readonly accountToken: string | null;
  readonly accountLabel: string | null;
}

export interface ICloudDriveNativeEntry {
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly downloaded: boolean;
  readonly conflicted: boolean;
}

export interface ICloudDriveNativeListPage {
  readonly entries: readonly ICloudDriveNativeEntry[];
  readonly nextCursor: string | null;
  readonly accountToken: string;
}

export class ICloudDriveNativeError extends Error {
  constructor(readonly code: ICloudDriveNativeErrorCode) {
    super('iCloud Drive native operation failed');
  }
}

export interface ICloudDriveNativeBridge {
  drain(): Promise<void>;
  status(): Promise<ICloudDriveNativeStatus>;
  replaceFile(path: string, sourceFile: string, accountToken: string): Promise<void>;
  materializeFile(path: string, destinationFile: string, accountToken: string): Promise<void>;
  list(path: string, cursor: string | null, limit: number, accountToken: string): Promise<ICloudDriveNativeListPage>;
  delete(path: string, accountToken: string): Promise<void>;
}

interface NativeBinding {
  status(bundleId: string, containerId: string): Promise<unknown>;
  replaceFile(bundleId: string, containerId: string, path: string, sourceFile: string, accountToken: string): Promise<void>;
  materializeFile(bundleId: string, containerId: string, path: string, destinationFile: string, accountToken: string): Promise<void>;
  list(bundleId: string, containerId: string, path: string, cursor: string | null, limit: number, accountToken: string): Promise<unknown>;
  delete(bundleId: string, containerId: string, path: string, accountToken: string): Promise<void>;
}

export interface NativeICloudDriveBridgeOptions {
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly loadBinding?: () => unknown;
}

const nativeErrorCodes = new Set<ICloudDriveNativeErrorCode>([
  'unavailable',
  'unentitled',
  'account-unavailable',
  'account-changed',
  'offline',
  'materialization-delayed',
  'conflict',
  'not-found',
  'invalid-path',
  'io-failure',
]);

const unavailableReasons = new Set<ICloudDriveUnavailableReason>([
  'unsupported-platform',
  'unsigned-build',
  'native-unavailable',
  'unentitled',
  'account-unavailable',
]);

function defaultLoadBinding(): unknown {
  return nativeRequire('@overlook/touch-id/icloud.cjs');
}

function isNativeBinding(value: unknown): value is NativeBinding {
  if (typeof value !== 'object' || value === null) return false;
  const binding = value as Record<string, unknown>;
  return ['status', 'replaceFile', 'materializeFile', 'list', 'delete'].every((method) => typeof binding[method] === 'function');
}

function failClosed(reason: ICloudDriveUnavailableReason): ICloudDriveNativeBridge {
  const reject = (): Promise<never> => Promise.reject(new ICloudDriveNativeError('unavailable'));
  return {
    drain: () => Promise.resolve(),
    status: () => Promise.resolve({ available: false, reason, accountToken: null, accountLabel: null }),
    replaceFile: reject,
    materializeFile: reject,
    list: reject,
    delete: reject,
  };
}

function normalizeStatus(value: unknown): ICloudDriveNativeStatus {
  if (typeof value !== 'object' || value === null) {
    return { available: false, reason: 'native-unavailable', accountToken: null, accountLabel: null };
  }
  const result = value as Record<string, unknown>;
  if (
    result['available'] === true &&
    result['reason'] === null &&
    typeof result['accountToken'] === 'string' &&
    ACCOUNT_TOKEN.test(result['accountToken'])
  ) {
    const accountLabel =
      typeof result['accountLabel'] === 'string' && result['accountLabel'].trim() !== '' ? result['accountLabel'].trim() : null;
    return { available: true, reason: null, accountToken: result['accountToken'], accountLabel };
  }
  if (
    result['available'] === false &&
    typeof result['reason'] === 'string' &&
    unavailableReasons.has(result['reason'] as ICloudDriveUnavailableReason) &&
    result['accountToken'] === null
  ) {
    return { available: false, reason: result['reason'] as ICloudDriveUnavailableReason, accountToken: null, accountLabel: null };
  }
  return { available: false, reason: 'native-unavailable', accountToken: null, accountLabel: null };
}

function mappedError(error: unknown): ICloudDriveNativeError {
  if (error instanceof ICloudDriveNativeError) return error;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && nativeErrorCodes.has(code as ICloudDriveNativeErrorCode)) {
      return new ICloudDriveNativeError(code as ICloudDriveNativeErrorCode);
    }
  }
  return new ICloudDriveNativeError('unavailable');
}

function validPath(path: string): void {
  if (!RELATIVE_PATH.test(path) || path.length > 1_024) throw new ICloudDriveNativeError('invalid-path');
}

function validFile(path: string): void {
  if (!isAbsolute(path) || path.length > 4_096) throw new ICloudDriveNativeError('invalid-path');
}

function validAccountToken(accountToken: string): void {
  if (!ACCOUNT_TOKEN.test(accountToken)) throw new ICloudDriveNativeError('account-changed');
}

function normalizeEntry(value: unknown): ICloudDriveNativeEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry['path'] !== 'string' ||
    !RELATIVE_PATH.test(entry['path']) ||
    typeof entry['size'] !== 'number' ||
    !Number.isSafeInteger(entry['size']) ||
    entry['size'] < 0 ||
    typeof entry['modifiedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(entry['modifiedAt'])) ||
    typeof entry['downloaded'] !== 'boolean' ||
    typeof entry['conflicted'] !== 'boolean'
  ) {
    return null;
  }
  return {
    path: entry['path'],
    size: entry['size'],
    modifiedAt: entry['modifiedAt'],
    downloaded: entry['downloaded'],
    conflicted: entry['conflicted'],
  };
}

function normalizePage(value: unknown): ICloudDriveNativeListPage {
  if (typeof value !== 'object' || value === null) throw new ICloudDriveNativeError('io-failure');
  const page = value as Record<string, unknown>;
  const entries = Array.isArray(page['entries']) ? page['entries'].map(normalizeEntry) : [];
  const nextCursor = page['nextCursor'];
  const accountToken = page['accountToken'];
  if (
    entries.some((entry) => entry === null) ||
    !(nextCursor === null || (typeof nextCursor === 'string' && CURSOR.test(nextCursor))) ||
    typeof accountToken !== 'string' ||
    !ACCOUNT_TOKEN.test(accountToken)
  ) {
    throw new ICloudDriveNativeError('io-failure');
  }
  return { entries: entries as ICloudDriveNativeEntry[], nextCursor, accountToken };
}

export function createNativeICloudDriveBridge(options: NativeICloudDriveBridgeOptions): ICloudDriveNativeBridge {
  if (options.platform !== 'darwin') return failClosed('unsupported-platform');
  if (!options.packaged) return failClosed('unsigned-build');

  let binding: NativeBinding;
  try {
    const loaded = (options.loadBinding ?? defaultLoadBinding)();
    if (!isNativeBinding(loaded)) return failClosed('native-unavailable');
    binding = loaded;
  } catch {
    return failClosed('native-unavailable');
  }

  const active = new CustodyWorkTracker();
  const invoke = <T>(operation: () => Promise<T>): Promise<T> => active.track(Promise.resolve().then(operation));

  return {
    drain: () => active.drain(),
    status: async () => {
      try {
        return normalizeStatus(await invoke(() => binding.status(OVERLOOK_MAC_BUNDLE_ID, OVERLOOK_ICLOUD_CONTAINER_ID)));
      } catch (error) {
        throw mappedError(error);
      }
    },
    replaceFile: async (path, sourceFile, accountToken) => {
      validPath(path);
      validFile(sourceFile);
      validAccountToken(accountToken);
      try {
        await invoke(() => binding.replaceFile(OVERLOOK_MAC_BUNDLE_ID, OVERLOOK_ICLOUD_CONTAINER_ID, path, sourceFile, accountToken));
      } catch (error) {
        throw mappedError(error);
      }
    },
    materializeFile: async (path, destinationFile, accountToken) => {
      validPath(path);
      validFile(destinationFile);
      validAccountToken(accountToken);
      try {
        await invoke(() =>
          binding.materializeFile(OVERLOOK_MAC_BUNDLE_ID, OVERLOOK_ICLOUD_CONTAINER_ID, path, destinationFile, accountToken),
        );
      } catch (error) {
        throw mappedError(error);
      }
    },
    list: async (path, cursor, limit, accountToken) => {
      validPath(path);
      if (cursor !== null && !CURSOR.test(cursor)) throw new ICloudDriveNativeError('invalid-path');
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new ICloudDriveNativeError('invalid-path');
      validAccountToken(accountToken);
      try {
        return normalizePage(
          await invoke(() => binding.list(OVERLOOK_MAC_BUNDLE_ID, OVERLOOK_ICLOUD_CONTAINER_ID, path, cursor, limit, accountToken)),
        );
      } catch (error) {
        throw mappedError(error);
      }
    },
    delete: async (path, accountToken) => {
      validPath(path);
      validAccountToken(accountToken);
      try {
        await invoke(() => binding.delete(OVERLOOK_MAC_BUNDLE_ID, OVERLOOK_ICLOUD_CONTAINER_ID, path, accountToken));
      } catch (error) {
        throw mappedError(error);
      }
    },
  };
}
