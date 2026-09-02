import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ActivityDraft, ActivityFacade } from '../../src/main/activity/activity-publication.js';
import { registerPhotoKitHandlersWith, type PhotoKitIpcHandlerRegistrar } from '../../src/main/photo-kit/photo-kit-ipc.js';
import type { PhotoKitService } from '../../src/main/photo-kit/photo-kit-service.js';
import { channels } from '../../src/shared/ipc/channels.js';

const REVIEW_ID = '11111111-1111-4111-8111-111111111111';

describe('PhotoKit IPC adapters (#798)', () => {
  test('validates and projects status, review, import, export, activity, and cancellation', async () => {
    const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
    const registrar: PhotoKitIpcHandlerRegistrar = {
      handle: (channel, handler) => handlers.set(channel, handler),
    };
    const activity: ActivityDraft[] = [];
    const facade = { record: (draft: ActivityDraft) => activity.push(draft) } as unknown as ActivityFacade;
    let imported = 0;
    let cancelled = 0;
    let admitted = 0;
    let importSummary = {
      imported: 1,
      moved: 0,
      retained: 1,
      duplicates: 0,
      failed: 0,
      cancelled: 0,
      sidecars: 0,
      photoIds: ['imported'],
      moveCompensations: [],
    };
    const service = {
      status: () => ({ available: true, reason: null, importAuthorization: 'authorized', exportAuthorization: 'authorized' }),
      reviewImport: () => Promise.resolve({ status: 'ready', authorization: 'authorized', reviewId: REVIEW_ID, assets: [] }),
      runImport: () => Promise.resolve(importSummary),
      runExport: (photoIds: readonly string[]) =>
        Promise.resolve({
          exported: 1,
          failed: 1,
          cancelled: 0,
          failures: [{ photoId: photoIds[1]!, fileName: 'missing.jpg', reason: 'missing' }],
        }),
      cancel: () => {
        cancelled += 1;
      },
    } as unknown as PhotoKitService;
    registerPhotoKitHandlersWith(
      () => service,
      () => {
        admitted += 1;
      },
      registrar,
      () => {
        imported += 1;
      },
      () => facade,
    );
    const invoke = (channel: string, request: unknown): Promise<unknown> => Promise.resolve(handlers.get(channel)?.({}, request));

    assert.deepEqual(await invoke(channels.photoKitStatus.name, {}), {
      available: true,
      reason: null,
      importAuthorization: 'authorized',
      exportAuthorization: 'authorized',
    });
    assert.deepEqual(await invoke(channels.photoKitImportReview.name, {}), {
      status: 'ready',
      authorization: 'authorized',
      reviewId: REVIEW_ID,
      assets: [],
    });
    assert.deepEqual(await invoke(channels.photoKitImportRun.name, { reviewId: REVIEW_ID, assetIds: ['asset'] }), {
      imported: 1,
      moved: 0,
      retained: 1,
      duplicates: 0,
      failed: 0,
      cancelled: 0,
      sidecars: 0,
    });
    assert.equal(imported, 1);
    assert.deepEqual(activity[0], {
      eventType: 'import.completed',
      outcome: 'succeeded',
      payload: { source: 'apple-photos', mode: 'copy', imported: 1, duplicates: 0, failed: 0, cancelled: 0 },
    });

    importSummary = { ...importSummary, imported: 0, retained: 0, failed: 1, photoIds: [] };
    await invoke(channels.photoKitImportRun.name, { reviewId: REVIEW_ID, assetIds: ['asset'] });
    assert.equal(imported, 1);
    assert.equal(activity[1]?.outcome, 'partial');

    assert.deepEqual(await invoke(channels.photoKitExportRun.name, { photoIds: ['photo', 'missing'] }), {
      exported: 1,
      failed: 1,
      cancelled: 0,
      failures: [{ photoId: 'missing', fileName: 'missing.jpg', reason: 'missing' }],
    });
    assert.deepEqual(activity[2], {
      eventType: 'photo.exported',
      entityIds: ['photo', 'missing'],
      outcome: 'partial',
      payload: {
        destination: 'apple-photos',
        format: 'original',
        metadata: 'embedded-supported',
        disclosureDestination: 'shared',
        disclosureWidened: '',
        disclosureNarrowed: '',
        exported: 1,
        failed: 1,
        cancelled: 0,
      },
    });
    assert.deepEqual(await invoke(channels.photoKitCancel.name, {}), {});
    assert.equal(cancelled, 1);
    assert.equal(admitted, 4);
  });

  test('keeps optional observers optional', async () => {
    const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
    const service = {
      runImport: () =>
        Promise.resolve({
          imported: 0,
          moved: 0,
          retained: 0,
          duplicates: 0,
          failed: 0,
          cancelled: 1,
          sidecars: 0,
          photoIds: [],
          moveCompensations: [],
        }),
      runExport: () => Promise.resolve({ exported: 0, failed: 0, cancelled: 1, failures: [] }),
    } as unknown as PhotoKitService;
    registerPhotoKitHandlersWith(
      () => service,
      () => undefined,
      { handle: (channel, handler) => handlers.set(channel, handler) },
    );
    const invoke = (channel: string, request: unknown): Promise<unknown> => Promise.resolve(handlers.get(channel)?.({}, request));

    assert.equal(
      ((await invoke(channels.photoKitImportRun.name, { reviewId: REVIEW_ID, assetIds: ['asset'] })) as { cancelled: number }).cancelled,
      1,
    );
    assert.equal(((await invoke(channels.photoKitExportRun.name, { photoIds: ['photo'] })) as { cancelled: number }).cancelled, 1);
  });
});
