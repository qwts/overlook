import { PhotosRepository } from '../db/photos-repository.js';
import { SidecarRepository } from '../db/sidecar-repository.js';
import { createExportRuntime, type DrainableExportFacade } from './export-runtime.js';
import type { EphemeralOriginalService } from '../backup/ephemeral-originals.js';
import type { BlobStore } from '../blobs/blob-store.js';
import type { KeyResolver } from '../crypto/envelope.js';

// Export facade wiring, extracted from the composition root. Offloaded
// originals stream through the ephemeral custody service and are released
// back to it when the export finishes.

export interface ExportFacadeFactoryDeps {
  readonly db: ConstructorParameters<typeof PhotosRepository>[0];
  readonly blobStore: BlobStore;
  readonly resolveKey: KeyResolver;
  readonly ephemeral: () => EphemeralOriginalService;
  readonly pickDestination: () => Promise<string | null>;
  readonly progress: (done: number, total: number) => void;
}

export function createExportFacade(deps: ExportFacadeFactoryDeps): DrainableExportFacade {
  const repo = new PhotosRepository(deps.db);
  const sidecars = new SidecarRepository(deps.db);
  return createExportRuntime({
    repo: { get: (id) => repo.get(id), exportableIds: () => repo.exportableIds() },
    blobs: deps.blobStore,
    resolveKey: deps.resolveKey,
    // Companions export beside their originals (#484, ADR-0031 §6).
    sidecarsFor: (photoId) => sidecars.listForPhoto(photoId),
    sidecarStream: (photoId, contentHash) => deps.blobStore.getSidecarStream(photoId, contentHash, deps.resolveKey),
    openOriginal: async (photo) => {
      const service = deps.ephemeral();
      const opened = await service.open(photo.id, 'export');
      return { stream: opened.stream, release: opened.custody === 'ephemeral' ? () => service.release(photo.id, 'export') : undefined };
    },
    pickDestination: deps.pickDestination,
    progress: deps.progress,
  });
}
