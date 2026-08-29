import { app, shell } from 'electron';

import { createNativeICloudDriveBridge } from '../backup/icloud-drive/native-bridge.js';
import { imageTrailExtensionId, pcloudFeatureConfig, type PCloudFeatureConfig } from '../build-config.js';
import { pickSafeStorage } from '../crypto/safe-storage-runtime.js';
import type { ImportRuntime } from '../import/import-runtime.js';
import type { LibraryParts } from '../library/library-parts.js';
import { runICloudNativeHost } from './icloud-native-runtime.js';
import { nativeHostInvocation, nativeHostUnregisterRequested, unregisterICloudNativeHost } from './icloud-native-registration.js';
import { startProductionInterop, type StartedProductionInterop } from './production-runtime.js';

export interface ProductionInteropAppOptions {
  readonly harnessEnv: (name: string) => string | undefined;
  readonly library: () => LibraryParts;
  readonly imports: () => ImportRuntime | undefined;
  readonly imported: () => void;
}

export interface ProductionInteropAppRuntime {
  readonly nativeHostRequested: boolean;
  readonly headlessRequested: boolean;
  readonly pcloud: PCloudFeatureConfig;
  runHeadless(): Promise<boolean>;
  startDesktop(): Promise<void>;
  lockDesktop(): Promise<void>;
  unlockDesktop(): void;
  closeDesktop(): Promise<void>;
}

/** Electron-specific edge wiring kept out of the desktop composition root so
 * native-host mode cannot accidentally start windows or single-instance IPC. */
export function createProductionInteropAppRuntime(options: ProductionInteropAppOptions): ProductionInteropAppRuntime {
  const pcloud = pcloudFeatureConfig(options.harnessEnv);
  const extensionId = imageTrailExtensionId(options.harnessEnv);
  const invocation = nativeHostInvocation(process.argv, extensionId);
  const unregisterRequested = nativeHostUnregisterRequested(process.argv);
  let desktop: StartedProductionInterop | null = null;
  return {
    nativeHostRequested: invocation.requested,
    headlessRequested: invocation.requested || unregisterRequested,
    pcloud,
    runHeadless: async () => {
      if (invocation.requested) {
        await runICloudNativeHost({
          invocation,
          extensionId,
          platform: process.platform,
          packaged: app.isPackaged,
          profileDirectory: app.getPath('userData'),
          safeStorage: pickSafeStorage(),
          bridge: createNativeICloudDriveBridge({ platform: process.platform, packaged: app.isPackaged }),
          input: process.stdin,
          output: process.stdout,
        });
        app.exit(0);
        return true;
      }
      if (!unregisterRequested) return false;
      await unregisterICloudNativeHost({
        platform: process.platform,
        packaged: app.isPackaged,
        applicationSupportDirectory: app.getPath('appData'),
        executablePath: app.getPath('exe'),
        extensionId,
      });
      app.exit(0);
      return true;
    },
    startDesktop: async () => {
      desktop = await startProductionInterop({
        pcloud: {
          config: pcloud,
          profileDirectory: app.getPath('userData'),
          safeStorage: pickSafeStorage(),
          openExternal: (url) => shell.openExternal(url),
          pcloudFixtureRoot: options.harnessEnv('OVERLOOK_INTEROP_PCLOUD_ROOT'),
          library: options.library,
          imports: options.imports,
          pairingFixture: () => options.harnessEnv('OVERLOOK_INTEROP_PAIRING_BUNDLE'),
          imported: options.imported,
        },
        nativeHost: {
          platform: process.platform,
          packaged: app.isPackaged,
          applicationSupportDirectory: app.getPath('appData'),
          executablePath: app.getPath('exe'),
          extensionId,
        },
        liveLocal: {
          enabled: extensionId !== null,
          platform: process.platform,
          profileDirectory: app.getPath('userData'),
          temporaryDirectory: app.getPath('temp'),
          expectedExtensionId: extensionId ?? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      });
    },
    lockDesktop: () => desktop?.lock() ?? Promise.resolve(),
    unlockDesktop: () => desktop?.unlock(),
    closeDesktop: () => desktop?.close() ?? Promise.resolve(),
  };
}
