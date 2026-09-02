import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { useFormats } from '../i18n/use-formats.js';
import { KeyringDialog, type KeyringDialogMode } from './KeyringDialog';
import type { KeyringEntry } from './keyring-entry.js';

import './keyring.css';

// Keyring section (#517, ADR-0032 §2): Settings ▸ Privacy lists every key
// the library has sealed objects under — reference, fingerprint, what it
// still seals — and offers the export, import and removal ceremonies. The
// list is registry fact from the main process; no material is ever shown.

const messages = defineMessages({
  title: { id: 'settings.keyring.title', defaultMessage: 'Encryption keys' },
  hint: {
    id: 'settings.keyring.hint',
    defaultMessage:
      'Every key this library has sealed photos under. Export a key before removing it — photos under a removed key stay locked until the same key is imported again.',
  },
  importKey: { id: 'settings.keyring.import', defaultMessage: 'Import key…' },
  exportKey: { id: 'settings.keyring.export', defaultMessage: 'Export…' },
  removeKey: { id: 'settings.keyring.remove', defaultMessage: 'Remove…' },
  keyName: { id: 'settings.keyring.keyName', defaultMessage: 'KEY #{id}' },
  writeKey: { id: 'settings.keyring.badge.writeKey', defaultMessage: 'Write key' },
  databaseKey: { id: 'settings.keyring.badge.databaseKey', defaultMessage: 'Database' },
  retired: { id: 'settings.keyring.badge.retired', defaultMessage: 'Retired' },
  absent: { id: 'settings.keyring.badge.absent', defaultMessage: 'Not on this device' },
  imported: { id: 'settings.keyring.badge.imported', defaultMessage: 'Imported' },
  usage: {
    id: 'settings.keyring.usage',
    defaultMessage:
      '{photos, plural, =0 {nothing sealed} one {# photo} other {# photos}}{sidecars, plural, =0 {} one { · # sidecar} other { · # sidecars}} · {bytes}',
  },
  empty: { id: 'settings.keyring.empty', defaultMessage: 'The keyring is unavailable until the library opens.' },
});

interface DialogState {
  readonly mode: KeyringDialogMode;
  readonly entry: KeyringEntry | null;
}

export function KeyringSection(): ReactElement {
  const intl = useIntl();
  const { formatBytes } = useFormats();
  const [keys, setKeys] = useState<readonly KeyringEntry[]>([]);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const refresh = useCallback(() => {
    void window.overlook.keyring
      .list()
      .then((result) => {
        setKeys(result.keys);
      })
      .catch(() => {
        setKeys([]);
      });
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <div className="ovl-keyring" data-testid="keyring-section">
      <div className="ovl-keyring__head">
        <div>
          <div className="ovl-settings__keytitle">{intl.formatMessage(messages.title)}</div>
          <div className="ovl-settings__keyhint">{intl.formatMessage(messages.hint)}</div>
        </div>
        <Button
          variant="secondary"
          icon="upload"
          data-testid="keyring-import"
          onClick={() => {
            setDialog({ mode: 'import', entry: null });
          }}
        >
          {intl.formatMessage(messages.importKey)}
        </Button>
      </div>
      {keys.length === 0 ? (
        <div className="ovl-keyring__empty">{intl.formatMessage(messages.empty)}</div>
      ) : (
        <ul className="ovl-keyring__list">
          {keys.map((key) => (
            <li key={key.id} className="ovl-keyring__row" data-testid={`keyring-row-${String(key.id)}`} data-present={key.present}>
              <Icon name={key.present ? 'key-round' : 'lock'} size={16} color={key.present ? 'var(--text-muted)' : 'var(--accent-amber)'} />
              <div className="ovl-keyring__body">
                <div className="ovl-keyring__title">
                  <span className="mono-data">{intl.formatMessage(messages.keyName, { id: String(key.id) })}</span>
                  {key.label === null ? null : <span>{key.label}</span>}
                  {key.active ? <Badge tone="green">{intl.formatMessage(messages.writeKey)}</Badge> : null}
                  {key.databaseKey ? <Badge tone="cyan">{intl.formatMessage(messages.databaseKey)}</Badge> : null}
                  {!key.active && key.present ? <Badge>{intl.formatMessage(messages.retired)}</Badge> : null}
                  {key.present ? null : <Badge tone="amber">{intl.formatMessage(messages.absent)}</Badge>}
                  {key.origin === 'imported' ? <Badge>{intl.formatMessage(messages.imported)}</Badge> : null}
                </div>
                <div className="ovl-keyring__meta mono-data">
                  {key.fingerprint ?? '—'} ·{' '}
                  {intl.formatMessage(messages.usage, {
                    photos: key.usage.photos,
                    sidecars: key.usage.sidecars,
                    bytes: formatBytes(key.usage.bytes),
                  })}
                </div>
              </div>
              <div className="ovl-settings__keyactions">
                <Button
                  variant="ghost"
                  icon="download"
                  disabled={!key.present}
                  data-testid={`keyring-export-${String(key.id)}`}
                  onClick={() => {
                    setDialog({ mode: 'export', entry: key });
                  }}
                >
                  {intl.formatMessage(messages.exportKey)}
                </Button>
                <Button
                  variant="ghost"
                  icon="trash-2"
                  disabled={!key.present || key.databaseKey || key.active}
                  data-testid={`keyring-remove-${String(key.id)}`}
                  onClick={() => {
                    setDialog({ mode: 'remove', entry: key });
                  }}
                >
                  {intl.formatMessage(messages.removeKey)}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {dialog === null ? null : (
        <KeyringDialog
          mode={dialog.mode}
          entry={dialog.entry}
          onClose={() => {
            setDialog(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
