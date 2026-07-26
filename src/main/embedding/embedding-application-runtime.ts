import path from 'node:path';

import { app, powerMonitor } from 'electron';

import { events } from '../../shared/ipc/channels.js';
import { createEmitter } from '../../shared/ipc/registry.js';
import type { LibraryParts } from '../library/library-parts.js';
import { getSettingsStore } from '../settings/settings-runtime.js';
import { createEmbeddingRuntime, executionProviders, type EmbeddingRuntime } from './embedding-runtime.js';

export interface EmbeddingApplicationRuntimeOptions {
  readonly parts: LibraryParts;
  readonly importBusy: () => boolean;
  readonly custodyBusy: () => boolean;
  readonly broadcast: (name: string, payload: unknown) => void;
}

export function createEmbeddingApplicationRuntime(options: EmbeddingApplicationRuntimeOptions): EmbeddingRuntime {
  const emit = createEmitter(events.embeddingStatusChanged, options.broadcast);
  return createEmbeddingRuntime({
    db: options.parts.db,
    blobs: options.parts.blobStore,
    resolveKey: options.parts.keyStore.resolver(),
    modelCacheRoot: path.join(app.getPath('userData'), 'models'),
    workerUrl: new URL('./embedding-worker.js', import.meta.url),
    providers: executionProviders(),
    enabled: () => getSettingsStore().get().semanticSearchEnabled,
    setEnabled: (semanticSearchEnabled) => {
      getSettingsStore().set({ semanticSearchEnabled });
    },
    pauseReason: () => {
      if (options.importBusy()) return 'import';
      if (options.custodyBusy()) return 'backup';
      if (powerMonitor.isOnBatteryPower()) return 'battery';
      return null;
    },
    emit,
  });
}
