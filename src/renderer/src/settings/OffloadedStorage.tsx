import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { useFormats } from '../i18n/use-formats.js';
import type { LibraryStats } from '../../../shared/library/types.js';
import { Button } from '../components/Button';
import { Field } from './Field';

export interface OffloadedStorageProps {
  readonly connection: 'loading' | 'connected' | 'disconnected' | 'error';
  readonly selectedPhotoIds: readonly string[];
}

export function OffloadedStorage({ connection, selectedPhotoIds }: OffloadedStorageProps): ReactElement {
  const { formatBytes, formatCount } = useFormats();
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [restoring, setRestoring] = useState<'selected' | 'all' | null>(null);
  const [result, setResult] = useState<{ readonly message: string; readonly failed: boolean } | null>(null);
  const refresh = useCallback(() => {
    void window.overlook.library.stats().then(setStats);
  }, []);

  useEffect(() => {
    refresh();
    return window.overlook.library.onStorageChanged(refresh);
  }, [refresh]);

  const restore = (mode: 'selected' | 'all'): void => {
    setRestoring(mode);
    setResult(null);
    const photoIds = mode === 'selected' ? [...selectedPhotoIds] : undefined;
    void window.overlook.backup
      .restoreOriginals(photoIds === undefined ? {} : { photoIds })
      .then(({ restored, skipped, failed }) => {
        const details = [`${formatCount(restored)} restored`];
        if (skipped > 0) details.push(`${formatCount(skipped)} skipped`);
        if (failed > 0) details.push(`${formatCount(failed)} failed`);
        setResult({ message: details.join(' · '), failed: failed > 0 });
        refresh();
      })
      .catch(() => {
        setResult({ message: 'Restore failed — originals remain offloaded', failed: true });
      })
      .finally(() => setRestoring(null));
  };

  const offloadedBytes = stats?.offloadedBytes ?? 0;
  const busy = restoring !== null;
  const connected = connection === 'connected';
  const showActions = connected || connection === 'disconnected';
  return (
    <Field
      layout="stacked"
      label="Offloaded originals"
      hint={`${formatBytes(offloadedBytes)} stored only in your verified cloud backup. Thumbnails remain on this Mac.`}
    >
      <div className="ovl-settings__restoreOriginals" aria-live="polite">
        {showActions ? (
          <div className="ovl-settings__restoreActions">
            <Button size="sm" disabled={!connected || selectedPhotoIds.length === 0 || busy} onClick={() => restore('selected')}>
              {restoring === 'selected' ? 'Restoring…' : `Restore selected (${formatCount(selectedPhotoIds.length)})`}
            </Button>
            <Button size="sm" disabled={!connected || offloadedBytes === 0 || busy} onClick={() => restore('all')}>
              {restoring === 'all' ? 'Restoring…' : 'Restore all'}
            </Button>
          </div>
        ) : null}
        {offloadedBytes > 0 && connection === 'loading' ? (
          <div className="ovl-settings__restoreState">Checking backup provider before restoring…</div>
        ) : offloadedBytes > 0 && connection === 'error' ? (
          <div className="ovl-settings__restoreState">Provider status is unavailable. Try again above.</div>
        ) : offloadedBytes > 0 && connection === 'disconnected' ? (
          <div className="ovl-settings__restoreState">Connect the backup provider to restore.</div>
        ) : null}
        {result === null ? null : (
          <div className={`ovl-settings__restoreState${result.failed ? ' ovl-settings__restoreState--error' : ''}`}>{result.message}</div>
        )}
      </div>
    </Field>
  );
}
