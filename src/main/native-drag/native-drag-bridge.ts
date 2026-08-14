import { createRequire } from 'node:module';

import { PHOTO_DRAG_TYPE } from '../../shared/library/photo-drag.js';

const nativeRequire = createRequire(import.meta.url);

export type NativeDragUnavailableReason = 'unsupported-platform' | 'unsigned-build' | 'native-unavailable';

export interface NativePromiseItem {
  readonly token: string;
  readonly fileName: string;
  readonly fileType: string;
}

export interface NativePromiseRequest {
  readonly token: string;
  readonly destinationPath: string;
}

export interface NativeDragStartInput {
  readonly windowHandle: Buffer;
  readonly items: readonly NativePromiseItem[];
  readonly internalPayload: string;
  readonly materialize: (request: NativePromiseRequest) => Promise<void>;
  readonly ended: () => void;
}

export interface NativeDragBridge {
  status(): { readonly available: boolean; readonly reason: NativeDragUnavailableReason | null };
  start(input: NativeDragStartInput): boolean;
  cancelAll(): void;
  close(): void;
}

interface NativeBinding {
  readonly status: (bundleId: string) => unknown;
  readonly startDrag: (
    bundleId: string,
    windowHandle: Buffer,
    items: readonly NativePromiseItem[],
    internalType: string,
    internalPayload: string,
    onRequest: (requestId: string, token: string, destinationPath: string) => void,
    onEnded: () => void,
  ) => unknown;
  readonly complete: (requestId: string, error: string | null) => void;
  readonly cancelAll: () => void;
}

function loadNativeBinding(): NativeBinding {
  return nativeRequire('@overlook/touch-id/drag.cjs') as NativeBinding;
}

function validBinding(value: unknown): value is NativeBinding {
  if (typeof value !== 'object' || value === null) return false;
  const binding = value as Partial<NativeBinding>;
  return (
    typeof binding.status === 'function' &&
    typeof binding.startDrag === 'function' &&
    typeof binding.complete === 'function' &&
    typeof binding.cancelAll === 'function'
  );
}

export function createNativeDragBridge(options: {
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly bundleId?: string | undefined;
  readonly loadBinding?: (() => unknown) | undefined;
}): NativeDragBridge {
  let binding: NativeBinding | null | undefined;
  let unavailable: NativeDragUnavailableReason | null = null;
  let closed = false;
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
      if (!validBinding(loaded)) throw new Error('unavailable');
      if (loaded.status(options.bundleId ?? 'com.zts1.overlook') !== true) {
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
  return {
    status: () => {
      const available = resolve() !== null;
      return { available, reason: available ? null : (unavailable ?? 'native-unavailable') };
    },
    start: (input) => {
      const native = resolve();
      if (native === null || input.items.length === 0) return false;
      try {
        const started = native.startDrag(
          options.bundleId ?? 'com.zts1.overlook',
          input.windowHandle,
          input.items,
          PHOTO_DRAG_TYPE,
          input.internalPayload,
          (requestId, token, destinationPath) => {
            void input.materialize({ token, destinationPath }).then(
              () => native.complete(requestId, null),
              () => native.complete(requestId, 'unavailable'),
            );
          },
          input.ended,
        );
        return started === true;
      } catch {
        return false;
      }
    },
    cancelAll: () => {
      resolve()?.cancelAll();
    },
    close: () => {
      if (closed) return;
      resolve()?.cancelAll();
      closed = true;
      binding = null;
    },
  };
}
