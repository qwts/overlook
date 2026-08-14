export type FileProviderUnavailableReason = 'unsupported-platform' | 'unsigned-build' | 'native-unavailable';

export interface FileProviderDomain {
  readonly id: string;
  readonly displayName: string;
}

/** Narrow main-process boundary. The extension never receives database or key access. */
export interface FileProviderBridge {
  status(): { readonly available: boolean; readonly reason: FileProviderUnavailableReason | null };
  stateDirectory(): string | null;
  register(domain: FileProviderDomain): Promise<void>;
  remove(domainId: string): Promise<void>;
  evict(domainId: string): Promise<void>;
  changed(domainId: string): Promise<void>;
  close(): void;
}

interface NativeBinding {
  readonly status: (bundleId: string, extensionId: string) => boolean;
  readonly stateDirectory: () => unknown;
  readonly register: (domain: FileProviderDomain, callback: (error?: unknown) => void) => void;
  readonly remove: (domainId: string, callback: (error?: unknown) => void) => void;
  readonly evict: (domainId: string, callback: (error?: unknown) => void) => void;
  readonly changed: (domainId: string, callback: (error?: unknown) => void) => void;
}

function validBinding(value: unknown): value is NativeBinding {
  if (typeof value !== 'object' || value === null) return false;
  const binding = value as Partial<NativeBinding>;
  return ['status', 'stateDirectory', 'register', 'remove', 'evict', 'changed'].every(
    (name) => typeof binding[name as keyof NativeBinding] === 'function',
  );
}

function invokeNative(start: (callback: (error?: unknown) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    start((error) => {
      if (error === undefined || error === null || error === '') resolve();
      else reject(error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'File Provider operation failed'));
    });
  });
}

function loadNativeBinding(): unknown {
  return nativeRequire('@overlook/touch-id/file-provider.cjs') as unknown;
}

export function createFileProviderBridge(options: {
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly bundleId?: string | undefined;
  readonly extensionId?: string | undefined;
  readonly loadBinding?: (() => unknown) | undefined;
}): FileProviderBridge {
  let binding: NativeBinding | null | undefined;
  let stateDirectory: string | undefined;
  let unavailable: FileProviderUnavailableReason = 'native-unavailable';
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
      const loaded: unknown = (options.loadBinding ?? loadNativeBinding)();
      if (!validBinding(loaded)) throw new Error('invalid File Provider binding');
      const bundleId = options.bundleId ?? 'com.zts1.overlook';
      const extensionId = options.extensionId ?? 'com.zts1.overlook.file-provider';
      const directory = loaded.stateDirectory();
      if (loaded.status(bundleId, extensionId) && typeof directory === 'string' && directory !== '') {
        binding = loaded;
        stateDirectory = directory;
      } else binding = null;
      if (binding === null) unavailable = 'unsigned-build';
    } catch {
      binding = null;
      unavailable = 'native-unavailable';
    }
    return binding;
  };
  const required = (): NativeBinding => {
    const current = resolve();
    if (current === null) throw new Error('File Provider is unavailable');
    return current;
  };
  return {
    status: () => {
      const available = resolve() !== null;
      return { available, reason: available ? null : unavailable };
    },
    stateDirectory: () => {
      required();
      return stateDirectory ?? null;
    },
    register: (domain) => invokeNative((callback) => required().register(domain, callback)),
    remove: (domainId) => invokeNative((callback) => required().remove(domainId, callback)),
    evict: (domainId) => invokeNative((callback) => required().evict(domainId, callback)),
    changed: (domainId) => invokeNative((callback) => required().changed(domainId, callback)),
    close: () => {
      closed = true;
      binding = null;
      stateDirectory = undefined;
    },
  };
}
import { createRequire } from 'node:module';

const nativeRequire = createRequire(import.meta.url);
