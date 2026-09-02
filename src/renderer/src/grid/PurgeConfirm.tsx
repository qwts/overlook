import type { ReactElement } from 'react';

import './pill.css';
import { useFormats } from '../i18n/use-formats.js';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { destructiveActions } from '../../../shared/destructive-actions.js';

export interface PurgeConfirmProps {
  readonly count: number;
  /** Rows kept on this device only (ADR-0033): no cloud copy to remove. */
  readonly excludedCount?: number;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

// ADR-0023 Tier D ceremony: exact count, complete custody effects, honest
// partial-failure behavior, and an action-specific destructive label.
export function PurgeConfirm({ count, excludedCount = 0, onCancel, onConfirm }: PurgeConfirmProps): ReactElement {
  const { formatCount } = useFormats();
  const noun = count === 1 ? 'photo' : 'photos';
  const action = destructiveActions.deletePhotosPermanently;
  return (
    <Dialog
      open
      title={`Delete ${formatCount(count)} ${noun} permanently?`}
      icon="trash-2"
      width={420}
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" icon="trash-2" onClick={onConfirm}>
            Delete permanently
          </Button>
        </>
      }
    >
      <p className="ovl-purge__copy">{action.sideEffects} This cannot be undone.</p>
      {excludedCount > 0 ? (
        <p className="ovl-purge__copy" data-testid="purge-excluded">
          {excludedCount === count
            ? count === 1
              ? 'This photo is kept on this device only: there is no cloud copy to remove.'
              : 'These photos are kept on this device only: there are no cloud copies to remove.'
            : `${formatCount(excludedCount)} of these ${excludedCount === 1 ? 'is' : 'are'} kept on this device only and ${excludedCount === 1 ? 'has' : 'have'} no cloud copy to remove.`}
        </p>
      ) : null}
    </Dialog>
  );
}
