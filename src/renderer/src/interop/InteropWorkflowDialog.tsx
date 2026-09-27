import type { ReactElement } from 'react';
import { FormattedMessage } from 'react-intl';
import type { InteropConflictAction, InteropOperation } from '../../../shared/interop/contract.js';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { ProgressBar } from '../components/ProgressBar';
import { INTEROP_REVIEW_LABELS, interopPhaseLabel, interopRecoveryLabel, type InteropVisibleWorkflow } from './visible-workflow.js';
import './interop.css';

export interface InteropWorkflowDialogProps {
  readonly state: InteropVisibleWorkflow;
  readonly onClose: () => void;
  readonly onOperationChange?: ((operation: InteropOperation) => void) | undefined;
  readonly onStart?: (() => void) | undefined;
  readonly onPause?: (() => void) | undefined;
  readonly onResume?: (() => void) | undefined;
  readonly onCancel?: (() => void) | undefined;
  readonly onReconnect?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly onDisconnect?: (() => void) | undefined;
  readonly onConflict?: ((interopId: string, action: InteropConflictAction, applyToAll: boolean) => void) | undefined;
}

const REVIEW_KEYS = ['eligible', 'duplicate', 'conflict', 'metadataOnly', 'unsupported', 'skipped'] as const;

export function InteropWorkflowDialog({
  state,
  onClose,
  onOperationChange,
  onStart,
  onPause,
  onResume,
  onCancel,
  onReconnect,
  onRetry,
  onDisconnect,
  onConflict,
}: InteropWorkflowDialogProps): ReactElement {
  const targetLabel = state.target === 'image-trail' ? 'Image Trail' : 'Overlook';
  return (
    <Dialog
      open
      title={state.operation === 'move' ? `Move to ${targetLabel}` : `Sync with ${targetLabel}`}
      icon="refresh-cw"
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button variant="secondary" disabled={state.provider.state !== 'connected'} onClick={onDisconnect}>
            Disconnect
          </Button>
          <Button
            variant="secondary"
            disabled={!['transferring', 'paused', 'awaiting-acknowledgement'].includes(state.phase)}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button variant="secondary" disabled={state.phase !== 'transferring'} onClick={onPause}>
            Pause
          </Button>
          <Button variant="secondary" disabled={state.phase !== 'paused'} onClick={onResume}>
            Resume
          </Button>
          <Button
            variant="primary"
            disabled={
              state.provider.state !== 'connected' || state.pairing !== 'unlocked' || !['queued', 'reviewing'].includes(state.phase)
            }
            onClick={onStart}
          >
            {state.operation === 'move' ? 'Start move' : 'Start sync'}
          </Button>
        </>
      }
    >
      <div className="ovl-interop" aria-live="polite" data-phase={state.phase}>
        <div className="ovl-interop__context prose-note">
          {state.entry} · {interopPhaseLabel(state.phase)}
        </div>
        <div className="ovl-interop__segmented" role="group" aria-label="Transfer operation">
          {(['move', 'sync'] as const).map((operation) => (
            <button
              key={operation}
              type="button"
              aria-pressed={state.operation === operation}
              disabled={onOperationChange === undefined}
              onClick={() => onOperationChange?.(operation)}
            >
              {operation === 'move' ? `Move to ${targetLabel}` : `Sync with ${targetLabel}`}
            </button>
          ))}
        </div>
        <section className="ovl-interop__provider" aria-label="Provider and pairing status">
          <strong>{state.provider.label}</strong>
          <span className="prose-note">
            {state.provider.state.replace('-', ' ')} · Pairing {state.pairing}
          </span>
          <p>{state.provider.detail}</p>
        </section>
        <dl className="ovl-interop__review">
          {REVIEW_KEYS.map((key) => (
            <div key={key}>
              <dt>{INTEROP_REVIEW_LABELS[key]}</dt>
              <dd>{state.counts[key]}</dd>
            </div>
          ))}
        </dl>
        <ProgressBar
          value={state.processed}
          max={Math.max(1, state.counts.total)}
          label="Transfer progress"
          detail={`${state.processed} / ${state.counts.total} · ${state.counts.acknowledged} acknowledged · ${state.counts.finalized} finalized`}
          tone={state.phase === 'completed' ? 'green' : state.phase === 'paused' ? 'amber' : 'cyan'}
        />
        {state.conflicts.map((conflict) => (
          <ConflictRow key={conflict.interopId} conflict={conflict} onConflict={onConflict} />
        ))}
        {state.error === null ? null : (
          <div className="ovl-interop__error" role="alert">
            <div>
              <strong>{state.error.code.replaceAll('-', ' ')}</strong> · {state.error.message}
            </div>
            <Button
              variant="secondary"
              disabled={!state.error.retryable}
              onClick={
                interopRecoveryLabel(state.error.code) === 'Resume'
                  ? onResume
                  : interopRecoveryLabel(state.error.code) === 'Reconnect'
                    ? onReconnect
                    : onRetry
              }
            >
              {interopRecoveryLabel(state.error.code)}
            </Button>
          </div>
        )}
        <div className="ovl-interop__truth">
          Originals marked unavailable remain metadata-only. Source removal starts only after verified target acknowledgement.
        </div>
      </div>
    </Dialog>
  );
}

function ConflictRow({
  conflict,
  onConflict,
}: {
  readonly conflict: InteropVisibleWorkflow['conflicts'][number];
  readonly onConflict: InteropWorkflowDialogProps['onConflict'];
}): ReactElement {
  const checkboxId = `interop-apply-${conflict.interopId}`;
  return (
    <fieldset className="ovl-interop__conflict">
      <legend>
        {conflict.label} · {conflict.fields.join(', ')}
      </legend>
      {onConflict === undefined ? (
        <p>
          <FormattedMessage id="interop.conflict.retained" defaultMessage="This item will remain at the source for review." />
        </p>
      ) : null}
      {onConflict === undefined
        ? null
        : (['keep-overlook', 'keep-image-trail', 'keep-both'] as const).map((action) => (
            <Button
              key={action}
              variant="secondary"
              onClick={(event) => {
                const fieldset = event.currentTarget.closest('fieldset');
                const applyToAll = fieldset?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked === true;
                onConflict?.(conflict.interopId, action, applyToAll);
              }}
            >
              {action === 'keep-overlook' ? 'Keep Overlook' : action === 'keep-image-trail' ? 'Keep Image Trail' : 'Keep both'}
            </Button>
          ))}
      {onConflict === undefined ? null : (
        <>
          <input id={checkboxId} type="checkbox" />
          <label htmlFor={checkboxId}>Apply to all conflicts</label>
        </>
      )}
    </fieldset>
  );
}
