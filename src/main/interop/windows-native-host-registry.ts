import { createRequire } from 'node:module';

const nativeRequire = createRequire(import.meta.url);
const REGISTRATION_COUNT = 4;

interface WindowsRegistryBinding {
  registerNativeHost(manifestPath: string): unknown;
  unregisterNativeHost(manifestPath: string): unknown;
}

export interface WindowsNativeHostRegistry {
  register(manifestPath: string): void;
  unregister(manifestPath: string): void;
}

function loadBinding(): WindowsRegistryBinding {
  return nativeRequire('@overlook/windows-interop/pipe.cjs') as WindowsRegistryBinding;
}

export function createWindowsNativeHostRegistry(): WindowsNativeHostRegistry {
  return {
    register: (manifestPath) => {
      if (loadBinding().registerNativeHost(manifestPath) !== REGISTRATION_COUNT) {
        throw new Error('Windows native-host registry registration was incomplete.');
      }
    },
    unregister: (manifestPath) => {
      const removed = loadBinding().unregisterNativeHost(manifestPath);
      if (typeof removed !== 'number' || !Number.isSafeInteger(removed) || removed < 0 || removed > REGISTRATION_COUNT) {
        throw new Error('Windows native-host registry cleanup returned an invalid result.');
      }
    },
  };
}
