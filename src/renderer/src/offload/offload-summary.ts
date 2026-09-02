import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { AppFormatters } from '../i18n/use-formats.js';

type OffloadResult = Awaited<ReturnType<OverlookApi['backup']['offload']>>;

/** Lightbox rehydrate failure (#100): the original is still with the provider. */
export function rehydrateFailedToast(providerLabel: string): { title: string; tone: 'red'; action: 'retry-backup' } {
  return { title: `Restore failed — still in ${providerLabel}`, tone: 'red', action: 'retry-backup' };
}
type OffloadReason = NonNullable<OffloadResult['results'][number]['reason']>;

const REASON_COPY: Record<OffloadReason, string> = {
  'missing-photo': 'no longer in this library',
  deleted: 'recently deleted',
  'provider-disconnected': 'cloud provider disconnected',
  'provider-expired': 'cloud connection expired',
  'provider-offline': 'cloud provider offline',
  local: 'not backed up yet',
  syncing: 'backup still in progress',
  'already-offloaded': 'already offloaded',
  error: 'backup needs attention',
  dirty: 'changed since verified backup',
  'shared-original': 'original shared by another photo',
  'missing-original': 'local original missing',
  'remote-missing': 'cloud original missing',
  'remote-mismatch': 'cloud original failed verification',
  'remote-unverified': 'cloud original could not be verified',
  'delete-failed': 'local removal failed',
};

export function offloadReasonLabel(reason: OffloadReason): string {
  return REASON_COPY[reason];
}

export function formatOffloadResultTitle(result: OffloadResult, formats: Pick<AppFormatters, 'formatBytes' | 'formatCount'>): string {
  const { formatBytes, formatCount } = formats;
  const summary = [`Offloaded ${formatCount(result.offloaded)}`];
  if (result.skipped > 0) summary.push(`${formatCount(result.skipped)} skipped`);
  if (result.failed > 0) summary.push(`${formatCount(result.failed)} failed`);
  summary.push(`Freed ${formatBytes(result.freedBytes)}`);

  const reasons = new Map<OffloadReason, number>();
  for (const item of result.results) {
    if (item.reason !== null) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
  }
  if (reasons.size === 0) return summary.join(' · ');
  const detail = [...reasons].map(([reason, count]) => `${formatCount(count)} ${offloadReasonLabel(reason)}`).join(', ');
  return `${summary.join(' · ')} — ${detail}`;
}
