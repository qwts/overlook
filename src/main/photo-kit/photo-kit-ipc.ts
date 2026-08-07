import { ipcMain } from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler } from '../../shared/ipc/registry.js';
import type { ActivityFacade } from '../activity/activity-publication.js';
import type { PhotoKitService } from './photo-kit-service.js';

export function registerPhotoKitHandlers(
  getService: () => PhotoKitService,
  admit: () => void,
  onImported?: () => void,
  getActivity?: () => ActivityFacade,
): void {
  ipcMain.handle(channels.photoKitStatus.name, (_event, request: unknown) =>
    wrapHandler(channels.photoKitStatus, () => getService().status())(request),
  );
  ipcMain.handle(channels.photoKitImportReview.name, (_event, request: unknown) =>
    wrapHandler(channels.photoKitImportReview, () => {
      admit();
      return getService().reviewImport();
    })(request),
  );
  ipcMain.handle(channels.photoKitImportRun.name, (_event, request: unknown) =>
    wrapHandler(channels.photoKitImportRun, async ({ reviewId, assetIds }) => {
      admit();
      const summary = await getService().runImport(reviewId, assetIds);
      if (summary.imported > 0) onImported?.();
      getActivity?.().record({
        eventType: 'import.completed',
        outcome: summary.failed > 0 || summary.cancelled > 0 ? 'partial' : 'succeeded',
        payload: {
          source: 'apple-photos',
          mode: 'copy',
          imported: summary.imported,
          duplicates: summary.duplicates,
          failed: summary.failed,
          cancelled: summary.cancelled,
        },
      });
      const { photoIds: _photoIds, moveCompensations: _moveCompensations, ...result } = summary;
      return result;
    })(request),
  );
  ipcMain.handle(channels.photoKitExportRun.name, (_event, request: unknown) =>
    wrapHandler(channels.photoKitExportRun, async ({ photoIds }) => {
      admit();
      const result = await getService().runExport(photoIds);
      getActivity?.().record({
        eventType: 'photo.exported',
        entityIds: photoIds,
        outcome: result.failed > 0 || result.cancelled > 0 ? 'partial' : 'succeeded',
        payload: {
          destination: 'apple-photos',
          format: 'original',
          metadata: 'embedded-supported',
          exported: result.exported,
          failed: result.failed,
          cancelled: result.cancelled,
        },
      });
      return { ...result, failures: [...result.failures] };
    })(request),
  );
  ipcMain.handle(channels.photoKitCancel.name, (_event, request: unknown) =>
    wrapHandler(channels.photoKitCancel, () => {
      getService().cancel();
      return {};
    })(request),
  );
}
