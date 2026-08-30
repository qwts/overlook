import { createHash } from 'node:crypto';

import { liveLocalOperationReviewSchema, type LiveLocalOperationReview } from '../../shared/interop/live-local-runtime.js';

/** Canonical identity for the user-reviewed operation choices carried by the
 * authenticated open frame and persisted by the route journal. */
export function liveLocalReviewScopeHash(reviewInput: LiveLocalOperationReview): string {
  const review = liveLocalOperationReviewSchema.parse(reviewInput);
  return createHash('sha256').update(JSON.stringify(review), 'utf8').digest('hex');
}
