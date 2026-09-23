import type { IntlShape } from 'react-intl';
import { photoCommandTargets } from '../commands/photo-command-targets.js';
import type { Dispatch } from 'react';

import type { DuplicateResult } from '../../../shared/ipc/variant-channels.js';
import type { AppAction, AppState } from '../../../shared/library/app-state.js';

// Duplicate (#496) from any surface: the request, the pending-count refresh,
// and the one honest sentence after it — how many variants exist now,
// whether their previews are still owed (originals not local), and how many
// requests were skipped because the source sits in Trash.

export function duplicateToast(result: DuplicateResult): NonNullable<AppState['toast']> {
  const created = result.created.length;
  const deferred = result.created.filter(({ derivatives }) => derivatives === 'deferred').length;
  const failed = result.created.filter(({ derivatives }) => derivatives === 'failed').length;
  const refused: string[] = [];
  if (result.skipped > 0) refused.push(`${String(result.skipped)} in Trash`);
  if (result.unsupported > 0) refused.push(`${String(result.unsupported)} with edits this build cannot render`);
  if (created === 0) {
    return { title: refused.length === 0 ? 'Nothing duplicated' : `Nothing duplicated — ${refused.join(', ')}`, tone: 'neutral' };
  }
  const parts = [`Duplicated ${String(created)} ${created === 1 ? 'photo' : 'photos'}`];
  if (deferred > 0) parts.push(`${String(deferred)} awaiting ${deferred === 1 ? 'its original' : 'originals'} for previews`);
  if (failed > 0) parts.push(`${String(failed)} without previews — repair will retry`);
  if (refused.length > 0) parts.push(`skipped ${refused.join(', ')}`);
  return { title: parts.join(' · '), tone: deferred > 0 || failed > 0 ? 'amber' : 'green' };
}

export function duplicatePhotos(dispatch: Dispatch<AppAction>, photoIds: readonly string[], intl: IntlShape): void {
  if (photoIds.length === 0) return;
  void photoCommandTargets('photo.duplicate', photoIds, intl).then(async ({ photoIds: eligible, notice }) => {
    if (eligible.length === 0) {
      if (notice !== null) dispatch({ type: 'toast/shown', toast: { title: notice, tone: 'amber' } });
      return;
    }
    const result = await window.overlook.variants.duplicate({ photoIds: [...eligible] });
    dispatch({ type: 'pendingCount/set', count: result.pendingCount });
    const toast = duplicateToast(result);
    dispatch({ type: 'toast/shown', toast: notice === null ? toast : { title: `${toast.title} · ${notice}`, tone: 'amber' } });
  });
}
