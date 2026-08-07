import type { EphemeralOriginalService } from './backup/ephemeral-originals.js';
import { PhotosRepository } from './db/photos-repository.js';
import { createExportFacade } from './export/export-facade-factory.js';
import type { DrainableExportFacade } from './export/export-runtime.js';
import type { LibraryParts } from './library/library-parts.js';
import { createNativeDragBridge } from './native-drag/native-drag-bridge.js';
import { NativeDragOutService } from './native-drag/native-drag-service.js';
import { TestNativeDragBridge } from './native-drag/test-native-drag-bridge.js';

export interface EgressRuntimeOptions {
  readonly parts: () => LibraryParts;
  readonly ephemeral: () => EphemeralOriginalService;
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly testDragDestination: () => string | undefined;
  readonly pickExportDestination: () => Promise<string | null>;
  readonly exportProgress: (done: number, total: number) => void;
  readonly unlocked: () => boolean;
}

export class EgressRuntime {
  private exportFacade: DrainableExportFacade | undefined;
  private dragOut: NativeDragOutService | undefined;

  constructor(private readonly options: EgressRuntimeOptions) {}

  exports(): DrainableExportFacade {
    const parts = this.options.parts();
    this.exportFacade ??= createExportFacade({
      db: parts.db,
      blobStore: parts.blobStore,
      resolveKey: parts.keyStore.resolver(),
      ephemeral: this.options.ephemeral,
      pickDestination: this.options.pickExportDestination,
      progress: this.options.exportProgress,
    });
    return this.exportFacade;
  }

  nativeDrag(): NativeDragOutService {
    if (this.dragOut !== undefined) return this.dragOut;
    const parts = this.options.parts();
    const repo = new PhotosRepository(parts.db);
    const testDestination = this.options.testDragDestination();
    this.dragOut = new NativeDragOutService({
      bridge:
        testDestination === undefined
          ? createNativeDragBridge({ platform: this.options.platform, packaged: this.options.packaged })
          : new TestNativeDragBridge(testDestination),
      getPhoto: (photoId) => repo.get(photoId),
      openOriginal: async (photo) => {
        const service = this.options.ephemeral();
        const opened = await service.open(photo.id, 'export');
        return { stream: opened.stream, release: opened.custody === 'ephemeral' ? () => service.release(photo.id, 'export') : undefined };
      },
      admit: () => this.options.unlocked() && this.options.parts() === parts,
    });
    return this.dragOut;
  }

  close(): void {
    this.exportFacade?.close();
    this.dragOut?.close();
  }

  drain(): Promise<void> {
    return Promise.all([this.exportFacade?.drain() ?? Promise.resolve(), this.dragOut?.drain() ?? Promise.resolve()]).then(() => undefined);
  }

  reset(): void {
    this.exportFacade = undefined;
    this.dragOut = undefined;
  }
}
