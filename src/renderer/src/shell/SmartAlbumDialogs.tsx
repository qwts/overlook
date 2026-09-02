import { useState, type FormEvent, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { SmartPredicate } from '../../../shared/library/smart-album.js';
import type { AlbumListing } from '../../../shared/library/types.js';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { folderDestinations } from './AlbumFolderDialogs';

// Saving a Smart Album (#514, ADR-0030 §3): the current facet predicate
// becomes a collection of kind 'smart' — a name and a folder, nothing else.
// The document that is saved is byte-for-byte the one the facet bar shows.

const messages = defineMessages({
  title: { id: 'smartAlbum.save.title', defaultMessage: 'Save as Smart Album' },
  name: { id: 'smartAlbum.save.name', defaultMessage: 'Smart Album name' },
  folder: { id: 'smartAlbum.save.folder', defaultMessage: 'Folder' },
  topLevel: { id: 'smartAlbum.save.topLevel', defaultMessage: 'Top level (no folder)' },
  note: {
    id: 'smartAlbum.save.note',
    defaultMessage: 'A Smart Album keeps the query, not the photos: it re-evaluates every time it opens and never copies anything.',
  },
  cancel: { id: 'smartAlbum.save.cancel', defaultMessage: 'Cancel' },
  save: { id: 'smartAlbum.save.confirm', defaultMessage: 'Save' },
  saving: { id: 'smartAlbum.save.saving', defaultMessage: 'Saving…' },
  failed: { id: 'smartAlbum.save.failed', defaultMessage: 'Could not save the Smart Album. Try again.' },
});

export function SaveSmartAlbumDialog({
  predicate,
  albums,
  onClose,
  onComplete,
}: {
  readonly predicate: SmartPredicate;
  readonly albums: readonly AlbumListing[];
  readonly onClose: () => void;
  readonly onComplete: (album: AlbumListing) => void;
}): ReactElement {
  const intl = useIntl();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const folders = folderDestinations(albums, null);
  const formId = 'save-smart-album';
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (trimmed === '' || saving) return;
    setSaving(true);
    setError(null);
    void window.overlook.albums
      .create({ name: trimmed, kind: 'smart', parentId: parentId === '' ? null : parentId, predicate })
      .then(({ album }) => onComplete(album))
      .catch(() => {
        setSaving(false);
        setError(intl.formatMessage(messages.failed));
      });
  };
  return (
    <Dialog
      open
      title={intl.formatMessage(messages.title)}
      icon="funnel"
      {...(saving ? {} : { onClose })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {intl.formatMessage(messages.cancel)}
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={trimmed === '' || saving}>
            {intl.formatMessage(saving ? messages.saving : messages.save)}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        <label className="ovl-album-dialog__label" htmlFor={`${formId}-name`}>
          {intl.formatMessage(messages.name)}
        </label>
        <input
          id={`${formId}-name`}
          className="ovl-album-dialog__input"
          value={name}
          maxLength={120}
          autoFocus
          onChange={(event) => setName(event.currentTarget.value)}
        />
        {folders.length === 0 ? null : (
          <>
            <label className="ovl-album-dialog__label" htmlFor={`${formId}-folder`}>
              {intl.formatMessage(messages.folder)}
            </label>
            <select
              id={`${formId}-folder`}
              className="ovl-album-dialog__select"
              value={parentId}
              onChange={(event) => setParentId(event.currentTarget.value)}
            >
              <option value="">{intl.formatMessage(messages.topLevel)}</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
          </>
        )}
        <p className="ovl-album-dialog__safe-copy">{intl.formatMessage(messages.note)}</p>
        {error === null ? null : (
          <div className="ovl-album-dialog__error" role="alert">
            {error}
          </div>
        )}
      </form>
    </Dialog>
  );
}
