import { events } from '../../shared/ipc/channels.js';
import { createEmitter } from '../../shared/ipc/registry.js';
import { PhotosRepository } from '../db/photos-repository.js';
import { SidecarRepository } from '../db/sidecar-repository.js';
import type { LibraryParts } from '../library/library-parts.js';
import { createDriveImport, createImportRuntime, type ImportRuntime } from './import-runtime.js';

export interface ImportApplicationRuntimeOptions {
  readonly dataDir: string;
  readonly parts: LibraryParts;
  readonly harnessEnv: (name: string) => string | undefined;
  readonly broadcast: (name: string, payload: unknown) => void;
  readonly imported: (photoIds: readonly string[], pending: number) => void;
  readonly resumed: () => void;
}

export function createImportApplicationRuntime(options: ImportApplicationRuntimeOptions): ImportRuntime {
  const repo = new PhotosRepository(options.parts.db);
  const emitScanProgress = createEmitter(events.scanProgress, options.broadcast);
  const emitCopyProgress = createEmitter(events.importCopyProgress, options.broadcast);
  const emitThumbProgress = createEmitter(events.importThumbProgress, options.broadcast);
  const emitChanged = createEmitter(events.libraryChanged, options.broadcast);
  const emitPending = createEmitter(events.pendingCountChanged, options.broadcast);
  return createImportRuntime({
    dataDir: options.dataDir,
    // electron-vite bundles this module into out/main/index.js; the dedicated
    // worker entry is emitted beside that bundle.
    workerUrl: new URL('./thumbnail-worker.js', import.meta.url),
    repo,
    sidecars: new SidecarRepository(options.parts.db),
    blobs: options.parts.blobStore,
    blobsReady: options.parts.blobStoreReady,
    currentKey: () => options.parts.keyStore.currentKey(),
    resolveKey: options.parts.keyStore.resolver(),
    events: {
      scanProgress: (scanPath, progress) => emitScanProgress({ path: scanPath, ...progress }),
      copyProgress: (done, total) => emitCopyProgress({ done, total }),
      thumbProgress: (done, total) => emitThumbProgress({ done, total }),
      imported: (photoIds) => {
        emitChanged({ photoIds: [...photoIds], membership: 'library' });
        const pending = repo.stats().pending;
        emitPending({ count: pending });
        options.imported(photoIds, pending);
      },
    },
    fixtureSource: () => options.harnessEnv('OVERLOOK_IMPORT_SOURCE'),
    googleDrive: createDriveImport(options.dataDir, () => options.harnessEnv('OVERLOOK_GOOGLE_DRIVE_IMPORT_SOURCE')),
    resumed: options.resumed,
  });
}
