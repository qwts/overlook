import { useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { ApplicableTheme, InstalledTheme, ThemeImportResult } from '../../../shared/ipc/theme-channels.js';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { getApplicationThemeLayer } from '../theme/user-theme-layer';

const messages = defineMessages({
  dropHint: { id: 'settings.theme.dropHint', defaultMessage: 'Choose or drop one .overlook-theme.json file' },
  empty: { id: 'settings.theme.empty', defaultMessage: 'No custom themes installed.' },
  active: { id: 'settings.theme.active', defaultMessage: 'Active' },
  preview: { id: 'settings.theme.preview', defaultMessage: 'Preview' },
  remove: { id: 'settings.theme.remove', defaultMessage: 'Remove' },
  reset: { id: 'settings.theme.reset', defaultMessage: 'Reset appearance' },
  warningCount: { id: 'settings.theme.warningCount', defaultMessage: '{count, plural, one {# warning} other {# warnings}}' },
  keepTitle: { id: 'settings.theme.keepTitle', defaultMessage: 'Keep this theme?' },
  keepBody: { id: 'settings.theme.keepBody', defaultMessage: 'The preview will revert automatically in {seconds} seconds.' },
  keep: { id: 'settings.theme.keep', defaultMessage: 'Keep theme' },
  revert: { id: 'settings.theme.revert', defaultMessage: 'Revert' },
  invalidDrop: { id: 'settings.theme.invalidDrop', defaultMessage: 'Drop exactly one .overlook-theme.json file.' },
  pathlessDrop: { id: 'settings.theme.pathlessDrop', defaultMessage: 'This file has no readable local path. Use the picker instead.' },
  unavailable: { id: 'settings.theme.unavailable', defaultMessage: 'The theme is no longer available.' },
  failed: { id: 'settings.theme.failed', defaultMessage: 'The theme operation failed. Try again.' },
  missingNotice: {
    id: 'settings.theme.missingNotice',
    defaultMessage: 'The active theme file was missing, so Overlook restored the first-party appearance.',
  },
  invalidNotice: {
    id: 'settings.theme.invalidNotice',
    defaultMessage: 'The active theme no longer validated, so Overlook restored the first-party appearance.',
  },
  swatches: { id: 'settings.theme.swatches', defaultMessage: '{name} color swatches' },
  version: { id: 'settings.theme.version', defaultMessage: 'v{version}' },
});

interface PreviewState {
  readonly previewId: string;
  readonly expiresAt: number;
  readonly theme: ApplicableTheme;
}

function ThemeSwatches({ colors, label }: { readonly colors: readonly string[]; readonly label: string }): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (context === null || context === undefined) return;
    context.clearRect(0, 0, 96, 24);
    const width = 96 / Math.max(1, colors.length);
    colors.forEach((color, index) => {
      context.fillStyle = color;
      context.fillRect(index * width, 0, width + 1, 24);
    });
  }, [colors]);
  return (
    <span role="img" aria-label={label}>
      <canvas ref={canvasRef} className="ovl-theme-manager__swatches" width={96} height={24} aria-hidden="true" />
    </span>
  );
}

function frameSettled(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export function ThemeManager(): ReactElement {
  const intl = useIntl();
  const layer = getApplicationThemeLayer();
  const [themes, setThemes] = useState<readonly InstalledTheme[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(layer.notice());
  const previewRef = useRef<PreviewState | null>(null);

  const refresh = async (): Promise<void> => {
    const result = await window.overlook.themes.list();
    setThemes(result.themes);
    setActiveId(result.activeId);
  };

  useEffect(() => {
    let current = true;
    void window.overlook.themes.list().then(
      (result) => {
        if (!current) return;
        setThemes(result.themes);
        setActiveId(result.activeId);
      },
      () => {
        if (current) setErrors([intl.formatMessage(messages.failed)]);
      },
    );
    const unsubscribe = layer.subscribe(() => setNotice(layer.notice()));
    return () => {
      current = false;
      unsubscribe();
    };
  }, [intl, layer]);

  useEffect(() => {
    previewRef.current = preview;
    if (preview === null) return undefined;
    const update = (): void => {
      const remaining = Math.max(0, Math.ceil((preview.expiresAt - Date.now()) / 1_000));
      setSeconds(remaining);
      if (remaining === 0) {
        void window.overlook.themes.cancel({ previewId: preview.previewId });
        layer.cancelPreview();
        setPreview(null);
      }
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [layer, preview]);

  useEffect(
    () => () => {
      const pending = previewRef.current;
      if (pending !== null) {
        void window.overlook.themes.cancel({ previewId: pending.previewId });
        layer.cancelPreview();
      }
    },
    [layer],
  );

  const startPreview = async (id: string): Promise<void> => {
    setBusy(true);
    setErrors([]);
    const prior = previewRef.current;
    if (prior !== null) await window.overlook.themes.cancel({ previewId: prior.previewId });
    layer.cancelPreview();
    try {
      const result = await window.overlook.themes.preview({ id });
      const next = { previewId: result.previewId, expiresAt: result.expiresAt, theme: result.theme };
      layer.preview(result.theme);
      setPreview(next);
      previewRef.current = next;
      await frameSettled();
      const health = await window.overlook.themes.previewHealthy({ previewId: result.previewId });
      if (!health.accepted) {
        layer.cancelPreview();
        setPreview(null);
        setErrors([intl.formatMessage(messages.unavailable)]);
      }
    } catch {
      layer.cancelPreview();
      setPreview(null);
      setErrors([intl.formatMessage(messages.failed)]);
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async (operation: Promise<ThemeImportResult>): Promise<void> => {
    setBusy(true);
    setErrors([]);
    try {
      const result = await operation;
      if (result.status === 'invalid') {
        setErrors(result.errors.map((error) => `${error.path}: ${error.message}`));
        return;
      }
      if (result.status === 'imported') {
        await refresh();
        await startPreview(result.theme.id);
      }
    } catch {
      setErrors([intl.formatMessage(messages.failed)]);
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1 || !files[0]?.name.toLowerCase().endsWith('.overlook-theme.json')) {
      setErrors([intl.formatMessage(messages.invalidDrop)]);
      return;
    }
    const sourcePath = window.overlook.import.pathForFile(files[0]);
    if (sourcePath === '') {
      setErrors([intl.formatMessage(messages.pathlessDrop)]);
      return;
    }
    void handleImport(window.overlook.themes.importPath({ path: sourcePath }));
  };

  const keep = (): void => {
    if (preview === null) return;
    void window.overlook.themes.confirm({ previewId: preview.previewId }).then((result) => {
      if (result.confirmed) {
        layer.commitPreview();
        setActiveId(result.settings.userTheme);
      } else {
        layer.cancelPreview();
        setErrors([intl.formatMessage(messages.unavailable)]);
      }
      setPreview(null);
    });
  };

  const revert = (): void => {
    if (preview === null) return;
    void window.overlook.themes.cancel({ previewId: preview.previewId });
    layer.cancelPreview();
    setPreview(null);
  };

  const remove = (id: string): void => {
    void window.overlook.themes
      .remove({ id })
      .then((result) => {
        if (result.settings.userTheme === null) layer.setPersisted(null);
        return refresh();
      })
      .catch(() => setErrors([intl.formatMessage(messages.failed)]));
  };

  const reset = (): void => {
    void window.overlook.themes
      .reset()
      .then(() => {
        layer.reset();
        return refresh();
      })
      .catch(() => setErrors([intl.formatMessage(messages.failed)]));
  };

  return (
    <div className="ovl-theme-manager">
      <div className="ovl-theme-manager__toolbar">
        <button
          type="button"
          className="ovl-theme-manager__drop"
          data-overlook-file-drop-target="theme"
          disabled={busy}
          onClick={() => void handleImport(window.overlook.themes.pickImport())}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={onDrop}
        >
          <Icon name="upload" size={16} />
          <span>{intl.formatMessage(messages.dropHint)}</span>
        </button>
        <Button size="sm" icon="rotate-ccw" disabled={busy} onClick={reset}>
          {intl.formatMessage(messages.reset)}
        </Button>
      </div>
      {notice === null ? null : (
        <div className="ovl-theme-manager__notice" role="status">
          {intl.formatMessage(notice === 'missing' ? messages.missingNotice : messages.invalidNotice)}
        </div>
      )}
      {errors.length === 0 ? null : (
        <ul className="ovl-theme-manager__errors" role="alert">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      {themes.length === 0 ? <div className="ovl-theme-manager__empty">{intl.formatMessage(messages.empty)}</div> : null}
      <ul className="ovl-theme-manager__list">
        {themes.map((theme) => (
          <li key={theme.id} className="ovl-theme-manager__theme">
            <ThemeSwatches colors={theme.swatches} label={intl.formatMessage(messages.swatches, { name: theme.meta.name })} />
            <div className="ovl-theme-manager__identity">
              <strong>{theme.meta.name}</strong>
              <span className="mono-data">{intl.formatMessage(messages.version, { version: theme.meta.version })}</span>
              {theme.warnings.length === 0 ? null : (
                <span className="ovl-theme-manager__warning">
                  {intl.formatMessage(messages.warningCount, { count: theme.warnings.length })}
                </span>
              )}
            </div>
            {activeId === theme.id ? <span className="ovl-theme-manager__active">{intl.formatMessage(messages.active)}</span> : null}
            <Button size="sm" disabled={busy} onClick={() => void startPreview(theme.id)}>
              {intl.formatMessage(messages.preview)}
            </Button>
            <Button size="sm" variant="ghost" icon="trash-2" disabled={busy} onClick={() => remove(theme.id)}>
              {intl.formatMessage(messages.remove)}
            </Button>
          </li>
        ))}
      </ul>
      <Dialog
        open={preview !== null}
        title={intl.formatMessage(messages.keepTitle)}
        onClose={revert}
        footer={
          <>
            <Button onClick={revert}>{intl.formatMessage(messages.revert)}</Button>
            <Button variant="primary" onClick={keep}>
              {intl.formatMessage(messages.keep)}
            </Button>
          </>
        }
      >
        <p>{intl.formatMessage(messages.keepBody, { seconds })}</p>
        {preview?.theme.warnings.length === 0 ? null : (
          <ul className="ovl-theme-manager__previewWarnings">
            {preview?.theme.warnings.map((warning) => (
              <li key={warning.message}>{warning.message}</li>
            ))}
          </ul>
        )}
      </Dialog>
    </div>
  );
}
