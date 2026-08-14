import type { ProviderRuntime } from './provider-runtime.js';
import type { OffloadService } from './offload.js';
import type { EphemeralOriginalService } from './ephemeral-originals.js';

export interface BackupFacadeOptions {
  readonly runtime: () => ProviderRuntime;
  readonly run: () => Promise<{
    uploaded: number;
    failed: number;
    skipped: 'wifi' | null;
    integrity: { checked: number; repaired: number; unrecoverable: number; recoveryRepaired: boolean; failed: boolean };
  }>;
  readonly offloadService: () => OffloadService;
  readonly ephemeralOriginalService: () => EphemeralOriginalService;
  readonly workChanged: (delta: 1 | -1) => void;
}

export function createBackupFacade(options: BackupFacadeOptions) {
  const withProviderWork = async <T>(operation: () => Promise<T>): Promise<T> => {
    options.workChanged(1);
    try {
      return await operation();
    } finally {
      options.workChanged(-1);
    }
  };
  return {
    run: () => {
      if (options.runtime().activeId() === null) {
        return Promise.resolve({
          uploaded: 0,
          failed: 0,
          skipped: 'disconnected' as const,
          integrity: { checked: 0, repaired: 0, unrecoverable: 0, recoveryRepaired: false, failed: false },
        });
      }
      return options.run();
    },
    offloadPreflight: (photoIds: readonly string[]) => withProviderWork(() => options.offloadService().preflight(photoIds)),
    offload: (photoIds: readonly string[]) => withProviderWork(() => options.offloadService().offload(photoIds)),
    rehydrate: (photoId: string) => withProviderWork(() => options.offloadService().rehydrate(photoId)),
    restoreOriginals: (photoIds?: readonly string[]) => withProviderWork(() => options.offloadService().restoreOriginals(photoIds)),
    keepDownloaded: (photoId: string) => withProviderWork(() => options.ephemeralOriginalService().keepDownloaded(photoId)),
    releaseEphemeral: (photoId: string) => options.ephemeralOriginalService().release(photoId),
    ephemeralStatus: (photoId: string) => options.ephemeralOriginalService().status(photoId),
    prepareEphemeral: (photoId: string) => options.ephemeralOriginalService().prepare(photoId, 'view'),
    providers: async () => ({ providers: await options.runtime().descriptors(), defaultProviderId: options.runtime().defaultTarget() }),
    providerStatus: (providerId: string) => options.runtime().status(providerId),
    providerStorage: (providerId: string) => options.runtime().storage(providerId),
    connect: (providerId: string) => options.runtime().connect(providerId),
    disconnect: (providerId: string) => options.runtime().disconnect(providerId),
    removeAuthorizationAnyway: (providerId: string) => options.runtime().removeAuthorizationAnyway(providerId),
    openCapacitySettings: (providerId: string) => options.runtime().openCapacitySettings(providerId),
  };
}
