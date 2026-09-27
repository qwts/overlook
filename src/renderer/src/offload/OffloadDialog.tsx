import { useEffect, useState, type ReactElement } from 'react';

import type { OverlookApi } from '../../../shared/ipc/api.js';
import { useFormats } from '../i18n/use-formats.js';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { offloadReasonLabel } from './offload-summary';

import './offload.css';

type Preflight = Awaited<ReturnType<OverlookApi['backup']['offloadPreflight']>>;
type OffloadResult = Awaited<ReturnType<OverlookApi['backup']['offload']>>;
type SkipReason = NonNullable<Preflight['items'][number]['reason']>;

export interface OffloadDialogProps {
  readonly photoIds: readonly string[];
  readonly onClose: () => void;
  readonly onComplete: (result: OffloadResult) => void;
}

export function OffloadDialog({ photoIds, onClose, onComplete }: OffloadDialogProps): ReactElement {
  const { formatBytes, formatCount } = useFormats();
  const [plan, setPlan] = useState<Preflight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let active = true;
    void window.overlook.backup
      .offloadPreflight({ photoIds: [...photoIds] })
      .then((loaded) => {
        if (active) setPlan(loaded);
      })
      .catch(() => {
        if (active) setError('Could not check cloud originals. Try again.');
      });
    return () => {
      active = false;
    };
  }, [photoIds]);

  const reasons = new Map<SkipReason, number>();
  for (const item of plan?.items ?? []) {
    if (item.reason !== null) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
  }

  return (
    <Dialog
      open
      title="Offload originals"
      icon="cloud-upload"
      {...(running ? {} : { onClose })}
      footer={
        <>
          <Button variant="secondary" disabled={running} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="cloud-upload"
            disabled={plan === null || plan.eligible === 0 || running}
            onClick={() => {
              setRunning(true);
              setError(null);
              void window.overlook.backup
                .offload({ photoIds: [...photoIds] })
                .then(onComplete)
                .catch(() => {
                  setRunning(false);
                  setError('Offload failed before any confirmed result. Your originals remain local.');
                });
            }}
          >
            {running ? 'Offloading…' : `Offload ${formatCount(plan?.eligible ?? 0)}`}
          </Button>
        </>
      }
    >
      <div className="ovl-offload" aria-live="polite">
        {plan === null && error === null ? <div className="ovl-offload__loading prose-note">Checking verified backups…</div> : null}
        {plan === null ? null : (
          <>
            <div className="ovl-offload__summary">
              <strong>
                {formatCount(plan.eligible)} {plan.eligible === 1 ? 'original' : 'originals'}
              </strong>{' '}
              can be removed from this Mac after confirmation.
            </div>
            <div className="ovl-offload__freed mono-data">Estimated space freed · {formatBytes(plan.estimatedFreedBytes)}</div>
            <div className="ovl-offload__safety">Encrypted cloud copies stay untouched. Thumbnails remain available offline.</div>
            {reasons.size === 0 ? null : (
              <div className="ovl-offload__skips">
                <div className="prose-note">{formatCount(plan.ineligible)} will be skipped</div>
                <ul>
                  {[...reasons].map(([reason, count]) => (
                    <li key={reason}>
                      {formatCount(count)} · {offloadReasonLabel(reason)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        {error === null ? null : <div className="ovl-offload__error">{error}</div>}
      </div>
    </Dialog>
  );
}
