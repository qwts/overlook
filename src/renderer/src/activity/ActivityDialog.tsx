import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { FormattedMessage, defineMessages, useIntl } from 'react-intl';

import type { ActivityEvent, ActivityEventType } from '../../../shared/activity/types.js';
import type { CapabilityReason, HistoryStatus } from '../../../shared/history/types.js';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { CopyableValue } from '../components/CopyableValue';

import './activity.css';

const messages = defineMessages({
  title: { id: 'activity.title', defaultMessage: 'Activity' },
  empty: { id: 'activity.empty', defaultMessage: 'Library activity will appear here.' },
  failed: { id: 'activity.failed', defaultMessage: 'Activity could not be loaded.' },
  loadMore: { id: 'activity.loadMore', defaultMessage: 'Load more' },
  undo: { id: 'activity.undo', defaultMessage: 'Undo' },
  redo: { id: 'activity.redo', defaultMessage: 'Redo' },
  copyEventId: { id: 'activity.copy.eventId', defaultMessage: 'activity event ID' },
  copyTimestamp: { id: 'activity.copy.timestamp', defaultMessage: 'activity timestamp' },
});

const reasonMessages: Readonly<Record<CapabilityReason, { readonly id: string; readonly defaultMessage: string }>> = {
  ready: { id: 'activity.history.ready', defaultMessage: 'Ready' },
  'empty-stack': { id: 'activity.history.empty', defaultMessage: 'No action available' },
  expired: { id: 'activity.history.expired', defaultMessage: 'The reversal window expired' },
  'state-changed': { id: 'activity.history.stateChanged', defaultMessage: 'The affected item changed' },
  'resource-missing': { id: 'activity.history.resourceMissing', defaultMessage: 'The affected item is missing' },
  'path-occupied': { id: 'activity.history.pathOccupied', defaultMessage: 'The original path is occupied' },
  'permission-denied': { id: 'activity.history.permissionDenied', defaultMessage: 'Permission is required' },
  'insufficient-space': { id: 'activity.history.insufficientSpace', defaultMessage: 'Not enough disk space' },
  'bytes-unavailable': { id: 'activity.history.bytesUnavailable', defaultMessage: 'Required data is unavailable' },
  irreversible: { id: 'activity.history.irreversible', defaultMessage: 'This action cannot be reversed' },
};

function countOf(event: ActivityEvent): number {
  return typeof event.payload['count'] === 'number'
    ? event.payload['count']
    : typeof event.payload['imported'] === 'number'
      ? event.payload['imported']
      : event.entityIds.length;
}

const eventMessages: Readonly<Record<ActivityEventType, { readonly id: string; readonly defaultMessage: string }>> = {
  'import.completed': { id: 'activity.event.import', defaultMessage: 'Imported {count, plural, one {# photo} other {# photos}}' },
  'album.created': { id: 'activity.event.albumCreated', defaultMessage: 'Created an album' },
  'album.renamed': { id: 'activity.event.albumRenamed', defaultMessage: 'Renamed an album' },
  'album.deleted': { id: 'activity.event.albumDeleted', defaultMessage: 'Deleted an album; photos were kept' },
  'album.reordered': { id: 'activity.event.albumReordered', defaultMessage: 'Reordered an album' },
  'board.layout-changed': { id: 'activity.event.boardLayout', defaultMessage: 'Edited a moodboard' },
  'album.membership-added': {
    id: 'activity.event.albumAdded',
    defaultMessage: 'Added {count, plural, one {# photo} other {# photos}} to an album',
  },
  'album.membership-removed': {
    id: 'activity.event.albumRemoved',
    defaultMessage: 'Removed {count, plural, one {# photo} other {# photos}} from an album',
  },
  'album.membership-moved': {
    id: 'activity.event.albumMoved',
    defaultMessage: 'Moved {count, plural, one {# photo} other {# photos}} between albums',
  },
  'photo.favorite-changed': { id: 'activity.event.favorite', defaultMessage: 'Changed a favorite' },
  'photo.trashed': {
    id: 'activity.event.trashed',
    defaultMessage: 'Moved {count, plural, one {# photo} other {# photos}} to Trash',
  },
  'photo.restored': {
    id: 'activity.event.restored',
    defaultMessage: 'Restored {count, plural, one {# photo} other {# photos}} from Trash',
  },
  'photo.exported': {
    id: 'activity.event.exported',
    defaultMessage: 'Exported {count, plural, one {# photo} other {# photos}}',
  },
  'photo.purged': {
    id: 'activity.event.purged',
    defaultMessage: 'Permanently deleted {count, plural, one {# photo} other {# photos}}',
  },
  'command.undone': { id: 'activity.event.undone', defaultMessage: 'Undid an action' },
  'command.redone': { id: 'activity.event.redone', defaultMessage: 'Redid an action' },
  'command.compensated': { id: 'activity.event.compensated', defaultMessage: 'Restored a moved source file' },
  'activity.pruned': { id: 'activity.event.pruned', defaultMessage: 'Expired old activity records' },
};

function HistoryControls({
  history,
  executing,
  execute,
}: {
  readonly history: HistoryStatus;
  readonly executing: 'undo' | 'redo' | null;
  readonly execute: (direction: 'undo' | 'redo') => Promise<void>;
}): ReactElement {
  const intl = useIntl();
  return (
    <div className="ovl-activity__history" aria-label={intl.formatMessage({ id: 'activity.history', defaultMessage: 'History controls' })}>
      {(['undo', 'redo'] as const).map((direction) => {
        const capability = history[direction];
        const available = capability.reason === 'ready';
        const reasonId = `activity-${direction}-reason`;
        return (
          <div className="ovl-activity__history-action" key={direction}>
            <Button
              variant="secondary"
              icon={direction === 'undo' ? 'rotate-ccw' : 'rotate-cw'}
              disabled={!available || executing !== null}
              aria-describedby={reasonId}
              onClick={() => void execute(direction)}
            >
              {intl.formatMessage(messages[direction])}
            </Button>
            <span id={reasonId} className="ovl-activity__history-reason">
              {intl.formatMessage(reasonMessages[capability.reason])}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ActivityDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }): ReactElement {
  const intl = useIntl();
  const [events, setEvents] = useState<readonly ActivityEvent[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [history, setHistory] = useState<HistoryStatus | null>(null);
  const [executing, setExecuting] = useState<'undo' | 'redo' | null>(null);

  const load = useCallback(async (next?: number): Promise<void> => {
    setStatus('loading');
    try {
      const [page, historyStatus] = await Promise.all([
        window.overlook.activity.page({ limit: 50, ...(next === undefined ? {} : { cursor: next }) }),
        window.overlook.history.status(),
      ]);
      setEvents((current) => (next === undefined ? page.events : [...current, ...page.events]));
      setCursor(page.nextCursor);
      setHistory(historyStatus);
      setStatus('ready');
    } catch {
      setStatus('failed');
    }
  }, []);

  const execute = useCallback(
    async (direction: 'undo' | 'redo'): Promise<void> => {
      setExecuting(direction);
      try {
        await window.overlook.history[direction]({ requestId: crypto.randomUUID() });
        await load();
      } finally {
        setExecuting(null);
      }
    },
    [load],
  );

  useEffect(() => {
    let active = true;
    if (open) {
      queueMicrotask(() => {
        if (active) void load();
      });
    }
    return () => {
      active = false;
    };
  }, [load, open]);

  return (
    <Dialog open={open} title={intl.formatMessage(messages.title)} icon="database" width={640} onClose={onClose}>
      <div className="ovl-activity" aria-busy={status === 'loading'}>
        <div className="sr-only" role="status" aria-live="polite">
          {status === 'loading' ? <FormattedMessage id="activity.loading" defaultMessage="Loading activity" /> : null}
        </div>
        {history === null ? null : <HistoryControls history={history} executing={executing} execute={execute} />}
        {status === 'failed' ? <p className="ovl-activity__state">{intl.formatMessage(messages.failed)}</p> : null}
        {status === 'ready' && events.length === 0 ? <p className="ovl-activity__state">{intl.formatMessage(messages.empty)}</p> : null}
        {events.length > 0 ? (
          <ol className="ovl-activity__list" aria-label={intl.formatMessage(messages.title)}>
            {events.map((event) => {
              const timestamp = `${intl.formatDate(event.occurredAt)} · ${intl.formatTime(event.occurredAt)}`;
              return (
                <li key={event.eventId} className="ovl-activity__item">
                  <span className="ovl-activity__marker" aria-hidden="true" />
                  <div className="ovl-activity__content">
                    <span className="ovl-activity__summary">
                      <FormattedMessage {...eventMessages[event.eventType]} values={{ count: countOf(event) }} />
                    </span>
                    <div className="ovl-activity__machineData">
                      <time className="ovl-activity__time" dateTime={event.occurredAt}>
                        <CopyableValue
                          value={timestamp}
                          label={intl.formatMessage(messages.copyTimestamp)}
                          className="ovl-activity__copyValue"
                        />
                      </time>
                      <CopyableValue
                        value={event.eventId}
                        label={intl.formatMessage(messages.copyEventId)}
                        className="ovl-activity__copyValue"
                      />
                    </div>
                    {event.outcome === 'partial' ? (
                      <span className="ovl-activity__partial">
                        <FormattedMessage id="activity.partial" defaultMessage="Completed with some items unresolved" />
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : null}
        {cursor === null ? null : (
          <div className="ovl-activity__more">
            <Button variant="ghost" disabled={status === 'loading'} onClick={() => void load(cursor)}>
              {intl.formatMessage(messages.loadMore)}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
