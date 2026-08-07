import { createRequire } from 'node:module';
import { z } from 'zod';

import {
  photoKitAssetSchema,
  photoKitAuthorizationSchema,
  type PhotoKitAsset,
  type PhotoKitAuthorization,
  type PhotoKitUnavailableReason,
} from '../../shared/ipc/photo-kit-channels.js';

const nativeRequire = createRequire(import.meta.url);

export type PhotoKitAccess = 'read-write' | 'add-only';

export interface PhotoKitMaterializedAsset extends PhotoKitAsset {
  readonly path: string;
}

export interface PhotoKitExportAsset {
  readonly photoId: string;
  readonly path: string;
  readonly fileName: string;
  readonly mediaType: 'image' | 'video';
  readonly createdAt: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

export interface PhotoKitBridge {
  status(): { readonly available: boolean; readonly reason: PhotoKitUnavailableReason | null };
  authorization(access: PhotoKitAccess): PhotoKitAuthorization;
  requestAuthorization(access: PhotoKitAccess): Promise<PhotoKitAuthorization>;
  assets(): readonly PhotoKitAsset[];
  materialize(assetIds: readonly string[], destination: string): Promise<readonly PhotoKitMaterializedAsset[]>;
  exportAssets(assets: readonly PhotoKitExportAsset[]): Promise<void>;
  cancelAll(): void;
  close(): void;
}

interface NativeBinding {
  readonly status: (bundleId: string) => unknown;
  readonly authorization: (access: PhotoKitAccess) => unknown;
  readonly requestAuthorization: (bundleId: string, access: PhotoKitAccess, callback: (status: unknown) => void) => void;
  readonly assets: (bundleId: string) => unknown;
  readonly materialize: (
    bundleId: string,
    assetIds: readonly string[],
    destination: string,
    callback: (error: unknown, assets: unknown) => void,
  ) => void;
  readonly exportAssets: (bundleId: string, assets: readonly PhotoKitExportAsset[], callback: (error: unknown) => void) => void;
  readonly cancelAll: () => void;
}

function loadNativeBinding(): NativeBinding {
  return nativeRequire('@overlook/touch-id/photokit.cjs') as NativeBinding;
}

function validBinding(value: unknown): value is NativeBinding {
  if (typeof value !== 'object' || value === null) return false;
  const binding = value as Partial<NativeBinding>;
  return (
    typeof binding.status === 'function' &&
    typeof binding.authorization === 'function' &&
    typeof binding.requestAuthorization === 'function' &&
    typeof binding.assets === 'function' &&
    typeof binding.materialize === 'function' &&
    typeof binding.exportAssets === 'function' &&
    typeof binding.cancelAll === 'function'
  );
}

function parseAuthorization(value: unknown): PhotoKitAuthorization {
  return photoKitAuthorizationSchema.catch('denied').parse(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function createPhotoKitBridge(options: {
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly bundleId?: string | undefined;
  readonly loadBinding?: (() => unknown) | undefined;
}): PhotoKitBridge {
  let binding: NativeBinding | null | undefined;
  let unavailable: PhotoKitUnavailableReason | null = null;
  let closed = false;
  const bundleId = options.bundleId ?? 'com.zts1.overlook';
  const resolve = (): NativeBinding | null => {
    if (closed) return null;
    if (options.platform !== 'darwin') {
      unavailable = 'unsupported-platform';
      return null;
    }
    if (!options.packaged) {
      unavailable = 'unsigned-build';
      return null;
    }
    if (binding !== undefined) return binding;
    try {
      const loaded = (options.loadBinding ?? loadNativeBinding)();
      if (!validBinding(loaded)) throw new Error('invalid PhotoKit binding');
      if (loaded.status(bundleId) !== true) {
        unavailable = 'unsigned-build';
        binding = null;
        return null;
      }
      binding = loaded;
      return binding;
    } catch {
      unavailable = 'native-unavailable';
      binding = null;
      return null;
    }
  };
  const required = (): NativeBinding => {
    const native = resolve();
    if (native === null) throw new Error('PhotoKit is unavailable');
    return native;
  };
  return {
    status: () => {
      const available = resolve() !== null;
      return { available, reason: available ? null : (unavailable ?? 'native-unavailable') };
    },
    authorization: (access) => {
      const native = resolve();
      return native === null ? 'denied' : parseAuthorization(native.authorization(access));
    },
    requestAuthorization: (access) =>
      new Promise((resolveAuthorization, reject) => {
        try {
          required().requestAuthorization(bundleId, access, (status) => resolveAuthorization(parseAuthorization(status)));
        } catch (error) {
          reject(asError(error));
        }
      }),
    assets: () => photoKitAssetSchema.array().max(5000).parse(required().assets(bundleId)),
    materialize: (assetIds, destination) =>
      new Promise((resolveMaterialized, reject) => {
        try {
          required().materialize(bundleId, assetIds, destination, (error, assets) => {
            if (error !== null && error !== undefined && error !== '') {
              reject(asError(error));
              return;
            }
            try {
              const parsed = photoKitAssetSchema
                .extend({ path: z.string().min(1).max(4096) })
                .array()
                .parse(assets);
              resolveMaterialized(parsed);
            } catch (parseError) {
              reject(asError(parseError));
            }
          });
        } catch (error) {
          reject(asError(error));
        }
      }),
    exportAssets: (assets) =>
      new Promise((resolveExport, reject) => {
        try {
          required().exportAssets(bundleId, assets, (error) => {
            if (error !== null && error !== undefined && error !== '') reject(asError(error));
            else resolveExport();
          });
        } catch (error) {
          reject(asError(error));
        }
      }),
    cancelAll: () => resolve()?.cancelAll(),
    close: () => {
      if (closed) return;
      resolve()?.cancelAll();
      closed = true;
      binding = null;
    },
  };
}
