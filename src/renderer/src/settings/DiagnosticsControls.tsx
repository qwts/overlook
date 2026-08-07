import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { destructiveActions } from '../../../shared/destructive-actions.js';
import { CopyableValue } from '../components/CopyableValue';
import './settings.css';

type DiagnosticReport = Awaited<ReturnType<typeof window.overlook.diagnostics.list>>['reports'][number];

const messages = defineMessages({
  off: { id: 'settings.diagnostics.off', defaultMessage: 'Diagnostics are off' },
  review: { id: 'settings.diagnostics.review', defaultMessage: 'Review reports…' },
  readFailed: { id: 'settings.diagnostics.readFailed', defaultMessage: 'Local reports could not be read.' },
  pending: {
    id: 'settings.diagnostics.pending',
    defaultMessage: '{count, plural, one {# pending local report} other {# pending local reports}}',
  },
  cleared: { id: 'settings.diagnostics.cleared', defaultMessage: 'Diagnostic report cleared.' },
  alreadyGone: { id: 'settings.diagnostics.alreadyGone', defaultMessage: 'That report was already gone.' },
  clearFailed: { id: 'settings.diagnostics.clearFailed', defaultMessage: 'The diagnostic report could not be cleared.' },
  clearedMany: {
    id: 'settings.diagnostics.clearedMany',
    defaultMessage: '{count, plural, one {# diagnostic report cleared.} other {# diagnostic reports cleared.}}',
  },
  clearManyFailed: { id: 'settings.diagnostics.clearManyFailed', defaultMessage: 'Local reports could not be cleared.' },
  exported: {
    id: 'settings.diagnostics.exported',
    defaultMessage: '{count, plural, one {# report exported.} other {# reports exported.}}',
  },
  exportCanceled: { id: 'settings.diagnostics.exportCanceled', defaultMessage: 'Export canceled.' },
  exportFailed: { id: 'settings.diagnostics.exportFailed', defaultMessage: 'Local reports could not be exported.' },
  title: { id: 'settings.diagnostics.title', defaultMessage: 'Review diagnostics' },
  exportAction: { id: 'settings.diagnostics.exportAction', defaultMessage: 'Export JSONL…' },
  done: { id: 'settings.diagnostics.done', defaultMessage: 'Done' },
  privacy: {
    id: 'settings.diagnostics.privacy',
    defaultMessage: 'These exact allowlisted payloads remain encrypted on this device. Nothing is sent.',
  },
  empty: { id: 'settings.diagnostics.empty', defaultMessage: 'No reports are waiting locally.' },
  clearReportAction: { id: 'settings.diagnostics.clearReportAction', defaultMessage: 'Clear report…' },
  clearManyTitle: {
    id: 'settings.diagnostics.clearManyTitle',
    defaultMessage: 'Clear {count, plural, one {# diagnostic report} other {# diagnostic reports}}?',
  },
  clearOneTitle: { id: 'settings.diagnostics.clearOneTitle', defaultMessage: 'Clear diagnostic report?' },
  cancel: { id: 'settings.diagnostics.cancel', defaultMessage: 'Cancel' },
  clearReport: { id: 'settings.diagnostics.clearReport', defaultMessage: 'Clear report' },
  clearManyCopy: {
    id: 'settings.diagnostics.clearManyCopy',
    defaultMessage: 'This removes all {count} encrypted diagnostic reports stored on this device.',
  },
  clearOneCopy: {
    id: 'settings.diagnostics.clearOneCopy',
    defaultMessage: 'This removes this encrypted diagnostic report from this device.',
  },
  cannotUndo: { id: 'settings.diagnostics.cannotUndo', defaultMessage: 'This cannot be undone.' },
  nothingSent: { id: 'settings.diagnostics.nothingSent', defaultMessage: 'Nothing was sent.' },
  copyEventId: { id: 'settings.diagnostics.copyEventId', defaultMessage: 'diagnostic event ID' },
  copyPayload: { id: 'settings.diagnostics.copyPayload', defaultMessage: 'diagnostic payload' },
});

export function DiagnosticsControls({ enabled }: { readonly enabled: boolean }): ReactElement {
  const intl = useIntl();
  if (!enabled) {
    return (
      <div className="ovl-settings__diagnostics">
        <span className="ovl-diagnostics__status">{intl.formatMessage(messages.off)}</span>
        <Button size="sm" variant="ghost" disabled>
          {intl.formatMessage(messages.review)}
        </Button>
      </div>
    );
  }
  return <EnabledDiagnosticsControls />;
}

function EnabledDiagnosticsControls(): ReactElement {
  const intl = useIntl();
  const [reports, setReports] = useState<DiagnosticReport[] | null>(null);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await window.overlook.diagnostics.list();
      setReports(result.reports);
      setNotice(null);
    } catch {
      setNotice(intl.formatMessage(messages.readFailed));
    }
  }, [intl]);

  useEffect(() => {
    let active = true;
    void window.overlook.diagnostics
      .list()
      .then((result) => {
        if (active) setReports(result.reports);
      })
      .catch(() => {
        if (active) setNotice(intl.formatMessage(messages.readFailed));
      });
    return () => {
      active = false;
    };
  }, [intl]);

  const pending = reports?.length ?? 0;
  return (
    <div className="ovl-settings__diagnostics">
      <span className="ovl-diagnostics__status" aria-live="polite">
        {intl.formatMessage(messages.pending, { count: pending })}
      </span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setOpen(true);
          void refresh();
        }}
      >
        {intl.formatMessage(messages.review)}
      </Button>
      <DiagnosticsReviewDialog
        open={open}
        reports={reports ?? []}
        notice={notice}
        onReports={setReports}
        onNotice={setNotice}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

interface ReviewProps {
  readonly open: boolean;
  readonly reports: readonly DiagnosticReport[];
  readonly notice: string | null;
  readonly onReports: (reports: DiagnosticReport[]) => void;
  readonly onNotice: (notice: string | null) => void;
  readonly onClose: () => void;
}

function DiagnosticsReviewDialog({ open, reports, notice, onReports, onNotice, onClose }: ReviewProps): ReactElement | null {
  const intl = useIntl();
  const [confirming, setConfirming] = useState<DiagnosticReport | 'all' | null>(null);
  const remove = async (eventId: string): Promise<void> => {
    try {
      const { deleted } = await window.overlook.diagnostics.delete({ eventId });
      if (deleted) onReports(reports.filter((report) => report.eventId !== eventId));
      onNotice(intl.formatMessage(deleted ? messages.cleared : messages.alreadyGone));
    } catch {
      onNotice(intl.formatMessage(messages.clearFailed));
    }
  };
  const purge = async (): Promise<void> => {
    try {
      const { deleted } = await window.overlook.diagnostics.purge();
      onReports([]);
      onNotice(intl.formatMessage(messages.clearedMany, { count: deleted }));
    } catch {
      onNotice(intl.formatMessage(messages.clearManyFailed));
    }
  };
  const exportReports = async (): Promise<void> => {
    try {
      const result = await window.overlook.diagnostics.export({ eventIds: reports.map((report) => report.eventId) });
      onNotice(
        result.exported ? intl.formatMessage(messages.exported, { count: result.count }) : intl.formatMessage(messages.exportCanceled),
      );
    } catch {
      onNotice(intl.formatMessage(messages.exportFailed));
    }
  };

  return (
    <Dialog
      open={open}
      title={intl.formatMessage(messages.title)}
      icon="shield-check"
      width={640}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" icon="download" onClick={() => void exportReports()}>
            {intl.formatMessage(messages.exportAction)}
          </Button>
          <Button variant="danger" icon="trash-2" disabled={reports.length === 0} onClick={() => setConfirming('all')}>
            {destructiveActions.clearDiagnostics.label}…
          </Button>
          <Button variant="primary" onClick={onClose}>
            {intl.formatMessage(messages.done)}
          </Button>
        </>
      }
    >
      <p>{intl.formatMessage(messages.privacy)}</p>
      {notice === null ? null : (
        <p className="ovl-diagnostics__notice" role="status">
          {notice}
        </p>
      )}
      {reports.length === 0 ? (
        <p>{intl.formatMessage(messages.empty)}</p>
      ) : (
        <div className="ovl-diagnostics__list">
          {reports.map((report) => (
            <article className="ovl-diagnostics__report" key={report.eventId}>
              <header>
                <div>
                  <strong>{report.kind}</strong>
                  <span>{intl.formatDate(report.capturedAt, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                  <CopyableValue
                    value={report.eventId}
                    label={intl.formatMessage(messages.copyEventId)}
                    className="ovl-diagnostics__eventId"
                  />
                </div>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(report)}>
                  {intl.formatMessage(messages.clearReportAction)}
                </Button>
              </header>
              <CopyableValue value={report.payload} label={intl.formatMessage(messages.copyPayload)} className="ovl-diagnostics__payload" />
            </article>
          ))}
        </div>
      )}
      <Dialog
        open={confirming !== null}
        title={
          confirming === 'all'
            ? intl.formatMessage(messages.clearManyTitle, { count: reports.length })
            : intl.formatMessage(messages.clearOneTitle)
        }
        icon="trash-2"
        width={440}
        onClose={() => setConfirming(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              {intl.formatMessage(messages.cancel)}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = confirming;
                setConfirming(null);
                if (target === 'all') void purge();
                else if (target !== null) void remove(target.eventId);
              }}
            >
              {confirming === 'all' ? destructiveActions.clearDiagnostics.label : intl.formatMessage(messages.clearReport)}
            </Button>
          </>
        }
      >
        <p>
          {confirming === 'all'
            ? intl.formatMessage(messages.clearManyCopy, { count: reports.length })
            : intl.formatMessage(messages.clearOneCopy)}{' '}
          {intl.formatMessage(messages.cannotUndo)}
        </p>
        <p>
          {destructiveActions.clearDiagnostics.survival} {intl.formatMessage(messages.nothingSent)}
        </p>
      </Dialog>
    </Dialog>
  );
}
