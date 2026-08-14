import type { RestoreProgressContract, RestoreStatusSnapshot } from '../../../shared/backup/restore-contract.js';

export function restoreStageLabel(stage: RestoreProgressContract['stage'], scanning = false): string {
  if (scanning || stage === 'verifying') return 'Scanning cloud backup';
  switch (stage) {
    case 'discovering':
      return 'Validating cloud backup';
    case 'downloading':
      return 'Downloading and verifying originals';
    case 'rebuilding':
      return 'Rebuilding thumbnails and catalog';
    case 'activating':
      return 'Activating restored library';
    case 'complete':
      return 'Restore complete';
  }
}

export function restoreProgressDetail(progress: RestoreProgressContract): string {
  const pct = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
  return `${String(progress.done)} / ${String(progress.total)} · ${String(pct)}%`;
}

export function restoreChipLabel(progress: RestoreProgressContract): string {
  const verb = progress.stage === 'verifying' ? 'Verifying' : 'Restoring';
  return progress.total === 0 ? verb : `${verb} ${String(progress.done)} / ${String(progress.total)}`;
}

export function restoreFallbackProgress(phase: RestoreStatusSnapshot['phase']): RestoreProgressContract {
  return {
    stage: phase === 'verify-scan' ? 'verifying' : 'discovering',
    done: 0,
    total: 0,
    photoId: null,
  };
}

export type RestoreWorkflowStep = 'setup' | 'choose' | 'verify' | 'confirm' | 'running' | 'complete';

export function restoreStepFromStatus(status: RestoreStatusSnapshot): RestoreWorkflowStep | null {
  switch (status.phase) {
    case 'verify-scan':
      return 'verify';
    case 'running':
      return 'running';
    case 'complete':
      return 'complete';
    case 'failed':
      return status.verification !== null ? 'confirm' : status.sessionId !== null ? 'choose' : 'setup';
    case 'session':
      if (status.verification !== null) {
        return status.verification.missingCount + status.verification.corruptCount > 0 ? 'verify' : 'confirm';
      }
      return 'choose';
    default:
      return null;
  }
}
