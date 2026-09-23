import type { AppAction } from '../../../shared/library/app-state.js';
import { useState, type ReactElement, type Dispatch } from 'react';
import { defineMessages, useIntl, type IntlShape } from 'react-intl';
import { commandById } from '../../../shared/commands/registry.js';
import { needsPhotoRepair, photoRepairBlocker, type RepairablePhoto } from '../../../shared/commands/photo-repair.js';
import type { PhotoRepairResult } from '../../../shared/ipc/photo-repair-channels.js';
import { Button } from '../components/Button.js';

const messages = defineMessages({
  repaired: { id: 'photo.repair.repaired', defaultMessage: 'Photo repaired.' },
  unchanged: { id: 'photo.repair.unchanged', defaultMessage: 'This photo no longer needs repair.' },
  failed: { id: 'photo.repair.failed', defaultMessage: 'The photo could not be repaired. Check its original and try again.' },
  unavailable: { id: 'photo.repair.unavailable', defaultMessage: 'Repair is unavailable for this photo.' },
  locked: { id: 'photo.repair.locked', defaultMessage: 'Return the photo key before retrying repair.' },
  offloaded: { id: 'photo.repair.offloaded', defaultMessage: 'Restore the original before retrying repair.' },
  unsupported: { id: 'photo.repair.unsupported', defaultMessage: 'Repair is not available for this media type.' },
});

export function repairDisabledReason(photo: RepairablePhoto, intl: IntlShape): string | undefined {
  const reason = photoRepairBlocker(photo);
  if (reason === null) return undefined;
  return intl.formatMessage(
    reason === 'locked' || reason === 'offloaded' || reason === 'unsupported' ? messages[reason] : messages.unavailable,
  );
}

/** Both projections invoke the same exact-photo IPC and result messages. */
export async function runPhotoRepair(photo: RepairablePhoto, intl: IntlShape): Promise<string> {
  if (photoRepairBlocker(photo) !== null) return intl.formatMessage(messages.unavailable);
  let status: PhotoRepairResult['status'];
  try {
    ({ status } = await window.overlook.library.repairPhoto({ photoId: photo.id }));
  } catch {
    status = 'failed';
  }
  return intl.formatMessage(messages[status]);
}

export function repairPhotoWithToast(dispatch: Dispatch<AppAction>, photo: RepairablePhoto, intl: IntlShape): void {
  void runPhotoRepair(photo, intl).then((title) => dispatch({ type: 'toast/shown', toast: { title, tone: 'neutral' } }));
}

export function PhotoRepairAction({ photo }: { readonly photo: RepairablePhoto }): ReactElement | null {
  const intl = useIntl();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  if (!needsPhotoRepair(photo) || photo.deletedAt !== null) return null;
  const reason = repairDisabledReason(photo, intl);
  return (
    <div>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy || reason !== undefined}
        title={reason}
        onClick={() => {
          setBusy(true);
          setResult(null);
          void runPhotoRepair(photo, intl)
            .then(setResult)
            .finally(() => setBusy(false));
        }}
      >
        {intl.formatMessage(commandById('photo.repair').label)}
      </Button>
      {reason === undefined ? null : <p className="mono-data">{reason}</p>}
      {result === null ? null : (
        <p className="mono-data" role="status">
          {result}
        </p>
      )}
    </div>
  );
}
