import type { BrowserWindow } from 'electron';
import type { z } from 'zod';

import type { channels } from '../../shared/ipc/channels.js';
import type { ActivityFacade } from '../activity/activity-publication.js';

export interface PurgeFacade {
  purge(photoIds: readonly string[]): Promise<{ purged: number; skipped: number; protected: number; remoteFailures: number }>;
}

export type PurgeAuthorizer = (photoIds: readonly string[], parent: BrowserWindow | null) => Promise<boolean>;

export async function purgeAfterAuthorization(
  photoIds: readonly string[],
  parent: BrowserWindow | null,
  getFacade: () => PurgeFacade,
  authorize: PurgeAuthorizer,
  getActivity?: () => Pick<ActivityFacade, 'record'>,
): Promise<z.output<typeof channels.libraryPurge.response>> {
  const exactRequest = Object.freeze([...photoIds]);
  if (!(await authorize(exactRequest, parent))) return { status: 'cancelled' };

  const result = await getFacade().purge(exactRequest);
  if (result.purged > 0 || result.remoteFailures > 0) {
    getActivity?.().record({
      eventType: 'photo.purged',
      outcome: result.remoteFailures > 0 || result.skipped > 0 ? 'partial' : 'succeeded',
      payload: { count: result.purged, skipped: result.skipped, remoteFailures: result.remoteFailures },
    });
  }
  return { status: 'completed', result };
}
