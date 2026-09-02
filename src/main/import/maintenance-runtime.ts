import { PhotosRepository } from '../db/photos-repository.js';
import type { ImportRuntime } from './import-runtime.js';
import type { LibraryParts } from '../library/library-parts.js';
import { captureVideoPosterFrame } from './offscreen-frame-capturer.js';
import { createPosterCaptureRuntime } from './poster-capture-runtime.js';
import type { PosterCaptureService } from './poster-capture-service.js';
import { createRawRepairRuntime } from './raw-repair-runtime.js';
import type { RawRepairService } from './raw-repair-service.js';
import { createPhotoEditRuntime } from '../library/photo-edit-runtime.js';
import type { PhotoEditService } from '../library/photo-edit-service.js';
import { createProvenanceRuntime } from '../library/provenance-runtime.js';
import type { ProvenanceService } from '../library/provenance-service.js';

// RAW/HEIC preview repair and video poster capture (ADR-0026 §6) are both
// post-import background passes over the same library parts, and persisted
// edits (#493) re-bake derivatives through the same thumbnail runtime; this
// keeps their wiring out of the app-bootstrap file. Renderer/library side effects are
// injected as callbacks so this module stays free of window/emitter details.
export interface MaintenanceContext {
  readonly parts: LibraryParts;
  readonly runtime: ImportRuntime;
  readonly appVersion: string;
  readonly invalidateThumb: (id: string) => void;
  readonly invalidateFull: (id: string) => void;
  readonly emitChanged: (photoIds: readonly string[]) => void;
  /** Derivative-only refresh (a captured poster): refresh just those tiles'
   * images without a page refetch, so a background poster completing never
   * resets scroll or drops the lightbox/selection (#744 review). */
  readonly emitThumbsChanged: (photoIds: readonly string[]) => void;
  readonly emitPending: (count: number) => void;
  readonly scheduleAutoBackup: () => void;
  readonly embeddingEligible: (photoIds: readonly string[]) => void;
}

export interface MaintenanceServices {
  readonly rawRepair: RawRepairService;
  readonly posterCapture: PosterCaptureService;
  readonly photoEdits: PhotoEditService;
  readonly provenance: ProvenanceService;
}

export function buildMaintenanceServices(ctx: MaintenanceContext): MaintenanceServices {
  const { parts, runtime } = ctx;
  const repo = new PhotosRepository(parts.db);
  const shared = {
    blobs: parts.blobStore,
    blobsReady: parts.blobStoreReady,
    thumbnails: runtime.thumbnails,
    currentKey: () => parts.keyStore.currentKey(),
    resolveKey: parts.keyStore.resolver(),
  };
  const rawRepair = createRawRepairRuntime({
    ...shared,
    repo,
    changed: (ids) => {
      for (const id of ids) {
        ctx.invalidateThumb(id);
        ctx.invalidateFull(id);
      }
      ctx.emitChanged(ids);
      ctx.emitPending(repo.stats().pending);
      ctx.scheduleAutoBackup();
      ctx.embeddingEligible(ids);
    },
  });
  const posterCapture = createPosterCaptureRuntime({
    ...shared,
    db: parts.db,
    captureFrame: captureVideoPosterFrame,
    changed: (ids) => {
      for (const id of ids) ctx.invalidateThumb(id);
      // Poster capture only regenerates a derivative — refresh the tiles, never
      // refetch the page (#744 review).
      ctx.emitThumbsChanged(ids);
      ctx.embeddingEligible(ids);
    },
  });
  const photoEdits = createPhotoEditRuntime({
    parts,
    runtime,
    appVersion: ctx.appVersion,
    invalidateThumb: ctx.invalidateThumb,
    emitThumbsChanged: ctx.emitThumbsChanged,
    emitPending: ctx.emitPending,
    scheduleAutoBackup: ctx.scheduleAutoBackup,
  });
  const provenance = createProvenanceRuntime({ parts, scheduleAutoBackup: ctx.scheduleAutoBackup });
  return { rawRepair, posterCapture, photoEdits, provenance };
}
