import { useEffect, useMemo, useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { RestoreProgressContract, RestoreStatusSnapshot } from '../../../shared/backup/restore-contract.js';
import type { ToastItem } from '../components/Toast.js';

const messages = defineMessages({
  showRestore: { id: 'restore.chrome.show', defaultMessage: 'Show restore' },
  complete: { id: 'restore.chrome.complete', defaultMessage: 'Restore complete' },
  completeMissing: { id: 'restore.missing.heading', defaultMessage: 'Restore complete — some items were NOT FOUND' },
});

function toastKey(status: RestoreStatusSnapshot): string {
  return `${status.phase}:${status.lastError?.message ?? status.lastResult?.generation ?? ''}`;
}

export function useRestoreChrome(): {
  readonly restoreOpen: boolean;
  readonly openRestore: () => void;
  readonly closeRestore: () => void;
  readonly restoreChip: RestoreProgressContract | null;
  readonly restoreToasts: readonly ToastItem[];
  readonly dismissRestoreToast: () => void;
} {
  const intl = useIntl();
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [status, setStatus] = useState<RestoreStatusSnapshot | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => {
    void window.overlook.restore.status().then(setStatus);
    const stopProgress = window.overlook.restore.onProgress((progress) => {
      setStatus((current) =>
        current === null
          ? current
          : {
              ...current,
              progress,
              phase: progress.stage === 'complete' ? 'complete' : current.phase === 'verify-scan' ? 'verify-scan' : 'running',
            },
      );
    });
    const stopStatus = window.overlook.restore.onStatusChanged(setStatus);
    return () => {
      stopProgress();
      stopStatus();
    };
  }, []);

  const toast = useMemo<ToastItem | null>(() => {
    if (restoreOpen || status === null) return null;
    const key = toastKey(status);
    if (dismissedKey === key) return null;
    const action = (
      <button type="button" className="ovl-toast__action" onClick={() => setRestoreOpen(true)}>
        {intl.formatMessage(messages.showRestore)}
      </button>
    );
    if (status.phase === 'failed' && status.lastError !== null) {
      return { id: 'restore-background', tone: 'red', title: status.lastError.message, action };
    }
    if (status.phase === 'complete') {
      const missing = status.lastResult !== null && status.lastResult.missing.length > 0;
      return {
        id: 'restore-background',
        tone: missing ? 'amber' : 'green',
        title: intl.formatMessage(missing ? messages.completeMissing : messages.complete),
        action,
      };
    }
    return null;
  }, [dismissedKey, intl, restoreOpen, status]);

  const restoreActive = status !== null && (status.phase === 'verify-scan' || status.phase === 'running');
  return {
    restoreOpen,
    openRestore: () => {
      if (status !== null) setDismissedKey(toastKey(status));
      setRestoreOpen(true);
    },
    closeRestore: () => setRestoreOpen(false),
    restoreChip: restoreActive && !restoreOpen ? (status.progress ?? { stage: 'discovering', done: 0, total: 1, photoId: null }) : null,
    restoreToasts: toast === null ? [] : [toast],
    dismissRestoreToast: () => {
      if (status !== null) setDismissedKey(toastKey(status));
    },
  };
}
