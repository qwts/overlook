import { useCallback, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { useAppDispatch } from '../state/app-state-context';
import { CoverageDialog } from './CoverageDialog';

// Backup coverage workflow (#506): "Keep on this device only…" opens the
// preflight-then-act dialog; "Back up again" needs no ceremony — it marks the
// rows dirty for the ordinary verified upload and reports what it could not
// re-enable (ADR-0033 §5 fails closed when the local original is missing).

const messages = defineMessages({
  excluded: {
    id: 'coverage.toast.excluded',
    defaultMessage: '{count, plural, one {# photo} other {# photos}} kept on this device only',
  },
  removalPending: {
    id: 'coverage.toast.removalPending',
    defaultMessage: '{count, plural, one {# cloud copy} other {# cloud copies}} still awaiting removal — will retry',
  },
  excludeFailed: {
    id: 'coverage.toast.excludeFailed',
    defaultMessage: '{count, plural, one {# photo} other {# photos}} could not be kept on this device only',
  },
  nothing: { id: 'coverage.toast.nothing', defaultMessage: 'No photos changed' },
  included: {
    id: 'coverage.toast.included',
    defaultMessage: 'Backing up {count, plural, one {# photo} other {# photos}} again',
  },
  includeFailed: {
    id: 'coverage.toast.includeFailed',
    defaultMessage: '{count, plural, one {# photo has} other {# photos have}} no original on this device — not backed up',
  },
  includeError: { id: 'coverage.toast.includeError', defaultMessage: 'Could not re-enable backup. Nothing changed.' },
});

export interface CoverageWorkflow {
  readonly open: (photoIds: readonly string[]) => void;
  readonly include: (photoIds: readonly string[]) => void;
  readonly dialog: ReactElement | null;
}

export function useCoverageWorkflow(): CoverageWorkflow {
  const intl = useIntl();
  const dispatch = useAppDispatch();
  const [photoIds, setPhotoIds] = useState<readonly string[] | null>(null);
  const open = useCallback((ids: readonly string[]): void => {
    setPhotoIds([...new Set(ids)]);
  }, []);
  const include = useCallback(
    (ids: readonly string[]): void => {
      void window.overlook.coverage
        .include({ photoIds: [...new Set(ids)] })
        .then((result) => {
          const parts = [
            ...(result.included > 0 ? [intl.formatMessage(messages.included, { count: result.included })] : []),
            ...(result.failed > 0 ? [intl.formatMessage(messages.includeFailed, { count: result.failed })] : []),
          ];
          dispatch({
            type: 'toast/shown',
            toast: {
              title: parts.length === 0 ? intl.formatMessage(messages.nothing) : parts.join(' · '),
              tone: result.failed > 0 ? 'red' : result.included > 0 ? 'green' : 'neutral',
            },
          });
        })
        .catch(() => {
          dispatch({ type: 'toast/shown', toast: { title: intl.formatMessage(messages.includeError), tone: 'red' } });
        });
    },
    [dispatch, intl],
  );
  const dialog =
    photoIds === null ? null : (
      <CoverageDialog
        photoIds={photoIds}
        onClose={() => setPhotoIds(null)}
        onComplete={(result) => {
          setPhotoIds(null);
          const parts = [
            ...(result.excluded > 0 ? [intl.formatMessage(messages.excluded, { count: result.excluded })] : []),
            ...(result.removalPending > 0 ? [intl.formatMessage(messages.removalPending, { count: result.removalPending })] : []),
            ...(result.failed > 0 ? [intl.formatMessage(messages.excludeFailed, { count: result.failed })] : []),
          ];
          dispatch({
            type: 'toast/shown',
            toast: {
              title: parts.length === 0 ? intl.formatMessage(messages.nothing) : parts.join(' · '),
              tone: result.failed > 0 ? 'red' : result.removalPending > 0 ? 'amber' : result.excluded > 0 ? 'green' : 'neutral',
            },
          });
        }}
      />
    );
  return { open, include, dialog };
}
