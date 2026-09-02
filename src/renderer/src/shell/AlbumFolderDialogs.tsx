import { useState, type FormEvent, type ReactElement } from 'react';
import { FormattedMessage, defineMessages, useIntl } from 'react-intl';

import { destructiveActions } from '../../../shared/destructive-actions.js';
import { albumDescendantIds, type AlbumTreeNode } from '../../../shared/library/album-tree.js';
import type { AlbumListing } from '../../../shared/library/types.js';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';

// Album folder ceremonies (#505, ADR-0030 §1 / ADR-0023 Tier M). Every
// dialog is keyboard-first (Enter submits, Escape closes) and every
// destructive one states what survives: photos are never among the counts.

const messages = defineMessages({
  cancel: { id: 'album.folder.dialog.cancel', defaultMessage: 'Cancel' },
  newFolderTitle: { id: 'album.folder.new.title', defaultMessage: 'New folder' },
  newFolderIn: { id: 'album.folder.new.titleIn', defaultMessage: 'New folder in {folder}' },
  newAlbumIn: { id: 'album.folder.newAlbum.titleIn', defaultMessage: 'New album in {folder}' },
  folderName: { id: 'album.folder.name', defaultMessage: 'Folder name' },
  albumName: { id: 'sidebar.album.name', defaultMessage: 'Album name' },
  create: { id: 'album.folder.create', defaultMessage: 'Create' },
  creating: { id: 'album.folder.creating', defaultMessage: 'Creating…' },
  createFailed: { id: 'album.folder.createFailed', defaultMessage: 'Could not create it. Try again.' },
  moveTitle: { id: 'album.move.title', defaultMessage: 'Move {name}' },
  moveDestination: { id: 'album.move.destination', defaultMessage: 'Folder' },
  topLevel: { id: 'album.move.topLevel', defaultMessage: 'Top level (no folder)' },
  move: { id: 'album.move.confirm', defaultMessage: 'Move' },
  moving: { id: 'album.move.moving', defaultMessage: 'Moving…' },
  moveFailed: { id: 'album.move.failed', defaultMessage: 'Could not move it. Try again.' },
  moveNote: {
    id: 'album.move.note',
    defaultMessage: 'A visible album adopts the folder’s All Photos setting; a hidden one keeps its own.',
  },
  deleteFolderQuestion: { id: 'album.folder.delete.question', defaultMessage: 'Delete “{name}”?' },
  deleteFolderEmpty: { id: 'album.folder.delete.empty', defaultMessage: 'The folder is empty. Nothing else is removed.' },
  deleteFolderMove: { id: 'album.folder.delete.move', defaultMessage: 'Move its contents to' },
  deleteFolderRecursive: {
    id: 'album.folder.delete.recursive',
    defaultMessage:
      'Also delete {folders, plural, =0 {} one {# folder} other {# folders}}{both, select, yes { and } other {}}{albums, plural, =0 {} one {# album} other {# albums}} inside it',
  },
  deleteFolderPhotos: { id: 'album.folder.delete.photos', defaultMessage: 'Photos are never deleted here.' },
  deleting: { id: 'album.folder.deleting', defaultMessage: 'Deleting…' },
  deleteFailed: { id: 'album.folder.deleteFailed', defaultMessage: 'Could not delete this folder. Try again.' },
  tagsTitle: { id: 'album.tags.title', defaultMessage: 'Tags for {name}' },
  tagsLabel: { id: 'album.tags.label', defaultMessage: 'Tags, separated by commas' },
  tagsNote: {
    id: 'album.tags.note',
    defaultMessage: 'Tags organize albums and folders in the sidebar. They are separate from photo keywords.',
  },
  save: { id: 'album.tags.save', defaultMessage: 'Save' },
  saving: { id: 'album.tags.saving', defaultMessage: 'Saving…' },
  saveFailed: { id: 'album.tags.saveFailed', defaultMessage: 'Could not save tags. Try again.' },
});

function ErrorLine({ error }: { readonly error: string | null }): ReactElement | null {
  return error === null ? null : (
    <div className="ovl-album-dialog__error" role="alert">
      {error}
    </div>
  );
}

/** Listings arrive in depth-first order, so the index is a valid global position. */
function treeNodes(albums: readonly AlbumListing[]): AlbumTreeNode[] {
  return albums.map((album, position) => ({ id: album.id, kind: album.kind, parentId: album.parentId, position }));
}

/** Folders that can receive `album` (or anything, when null): every folder
 * except the album itself and its descendants. */
export function folderDestinations(albums: readonly AlbumListing[], album: AlbumListing | null): AlbumListing[] {
  const excluded = new Set(album === null ? [] : [album.id, ...albumDescendantIds(treeNodes(albums), album.id)]);
  return albums.filter((candidate) => candidate.kind === 'folder' && !excluded.has(candidate.id));
}

export function folderContents(albums: readonly AlbumListing[], folderId: string): { readonly folders: number; readonly albums: number } {
  const byId = new Map(albums.map((album) => [album.id, album]));
  let folders = 0;
  let count = 0;
  for (const id of albumDescendantIds(treeNodes(albums), folderId)) {
    if (byId.get(id)?.kind === 'folder') folders += 1;
    else count += 1;
  }
  return { folders, albums: count };
}

export function NewCollectionDialog({
  kind,
  parent,
  onClose,
  onComplete,
}: {
  readonly kind: 'album' | 'folder';
  readonly parent: AlbumListing | null;
  readonly onClose: () => void;
  readonly onComplete: (album: AlbumListing) => void;
}): ReactElement {
  const intl = useIntl();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const formId = `new-collection-${parent?.id ?? 'root'}`;
  const title =
    parent === null
      ? intl.formatMessage(messages.newFolderTitle)
      : intl.formatMessage(kind === 'folder' ? messages.newFolderIn : messages.newAlbumIn, { folder: parent.name });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (trimmed === '' || saving) return;
    setSaving(true);
    setError(null);
    void window.overlook.albums
      .create({ name: trimmed, kind, parentId: parent?.id ?? null })
      .then(({ album }) => onComplete(album))
      .catch(() => {
        setSaving(false);
        setError(intl.formatMessage(messages.createFailed));
      });
  };
  return (
    <Dialog
      open
      title={title}
      icon={kind === 'folder' ? 'folder' : 'album'}
      {...(saving ? {} : { onClose })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {intl.formatMessage(messages.cancel)}
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={trimmed === '' || saving}>
            {intl.formatMessage(saving ? messages.creating : messages.create)}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        <label className="ovl-album-dialog__label" htmlFor={`${formId}-name`}>
          {intl.formatMessage(kind === 'folder' ? messages.folderName : messages.albumName)}
        </label>
        <input
          id={`${formId}-name`}
          className="ovl-album-dialog__input"
          value={name}
          maxLength={120}
          autoFocus
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <ErrorLine error={error} />
      </form>
    </Dialog>
  );
}

export function MoveAlbumDialog({
  album,
  albums,
  onClose,
  onComplete,
}: {
  readonly album: AlbumListing;
  readonly albums: readonly AlbumListing[];
  readonly onClose: () => void;
  readonly onComplete: (album: AlbumListing) => void;
}): ReactElement {
  const intl = useIntl();
  const [destination, setDestination] = useState(album.parentId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const destinations = folderDestinations(albums, album);
  const unchanged = (destination === '' ? null : destination) === album.parentId;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (unchanged || saving) return;
    setSaving(true);
    setError(null);
    void window.overlook.albums
      .move({ albumId: album.id, parentId: destination === '' ? null : destination })
      .then(({ album: moved }) => onComplete(moved))
      .catch(() => {
        setSaving(false);
        setError(intl.formatMessage(messages.moveFailed));
      });
  };
  return (
    <Dialog
      open
      title={intl.formatMessage(messages.moveTitle, { name: album.name })}
      icon="folder"
      {...(saving ? {} : { onClose })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {intl.formatMessage(messages.cancel)}
          </Button>
          <Button variant="primary" type="submit" form={`move-${album.id}`} disabled={unchanged || saving}>
            {intl.formatMessage(saving ? messages.moving : messages.move)}
          </Button>
        </>
      }
    >
      <form id={`move-${album.id}`} onSubmit={submit}>
        <label className="ovl-album-dialog__label" htmlFor={`move-${album.id}-destination`}>
          {intl.formatMessage(messages.moveDestination)}
        </label>
        <select
          id={`move-${album.id}-destination`}
          className="ovl-album-dialog__select"
          value={destination}
          autoFocus
          onChange={(event) => setDestination(event.currentTarget.value)}
        >
          <option value="">{intl.formatMessage(messages.topLevel)}</option>
          {destinations.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
        {album.kind === 'album' ? <p className="ovl-album-dialog__safe-copy">{intl.formatMessage(messages.moveNote)}</p> : null}
        <ErrorLine error={error} />
      </form>
    </Dialog>
  );
}

export function DeleteFolderDialog({
  folder,
  albums,
  onClose,
  onComplete,
}: {
  readonly folder: AlbumListing;
  readonly albums: readonly AlbumListing[];
  readonly onClose: () => void;
  readonly onComplete: (removed: { readonly folders: number; readonly albums: number }) => void;
}): ReactElement {
  const intl = useIntl();
  const contents = folderContents(albums, folder.id);
  const empty = contents.folders === 0 && contents.albums === 0;
  const destinations = folderDestinations(albums, folder);
  const [mode, setMode] = useState<'move' | 'recursive'>('move');
  const [destination, setDestination] = useState(folder.parentId ?? '');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = (): void => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    const request =
      empty || mode === 'move'
        ? { albumId: folder.id, folder: { mode: 'move' as const, destinationId: destination === '' ? null : destination } }
        : { albumId: folder.id, folder: { mode: 'recursive' as const } };
    void window.overlook.albums
      .delete(request)
      .then(() =>
        onComplete(mode === 'recursive' && !empty ? { folders: contents.folders + 1, albums: contents.albums } : { folders: 1, albums: 0 }),
      )
      .catch(() => {
        setDeleting(false);
        setError(intl.formatMessage(messages.deleteFailed));
      });
  };
  return (
    <Dialog
      open
      title={destructiveActions.deleteFolder.label}
      icon="trash-2"
      {...(deleting ? {} : { onClose })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={deleting}>
            {intl.formatMessage(messages.cancel)}
          </Button>
          <Button variant="danger" onClick={remove} disabled={deleting}>
            {deleting ? intl.formatMessage(messages.deleting) : destructiveActions.deleteFolder.label}
          </Button>
        </>
      }
    >
      <p>{intl.formatMessage(messages.deleteFolderQuestion, { name: folder.name })}</p>
      {empty ? (
        <p className="ovl-album-dialog__safe-copy">{intl.formatMessage(messages.deleteFolderEmpty)}</p>
      ) : (
        <fieldset className="ovl-album-dialog__choices">
          <legend className="ovl-sr-only">
            <FormattedMessage id="album.folder.delete.choices" defaultMessage="What happens to its contents" />
          </legend>
          <label className="ovl-album-dialog__choice">
            <input type="radio" name={`delete-${folder.id}`} value="move" checked={mode === 'move'} onChange={() => setMode('move')} />
            <span>{intl.formatMessage(messages.deleteFolderMove)}</span>
            <select
              className="ovl-album-dialog__select"
              aria-label={intl.formatMessage(messages.deleteFolderMove)}
              value={destination}
              disabled={mode !== 'move'}
              onChange={(event) => setDestination(event.currentTarget.value)}
            >
              <option value="">{intl.formatMessage(messages.topLevel)}</option>
              {destinations.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
          <label className="ovl-album-dialog__choice">
            <input
              type="radio"
              name={`delete-${folder.id}`}
              value="recursive"
              checked={mode === 'recursive'}
              onChange={() => setMode('recursive')}
            />
            <span>
              {intl.formatMessage(messages.deleteFolderRecursive, {
                folders: contents.folders,
                albums: contents.albums,
                both: contents.folders > 0 && contents.albums > 0 ? 'yes' : 'no',
              })}
            </span>
          </label>
        </fieldset>
      )}
      <p className="ovl-album-dialog__safe-copy">
        {destructiveActions.deleteFolder.survival} {intl.formatMessage(messages.deleteFolderPhotos)}
      </p>
      <ErrorLine error={error} />
    </Dialog>
  );
}

export function AlbumTagsDialog({
  album,
  onClose,
  onComplete,
}: {
  readonly album: AlbumListing;
  readonly onClose: () => void;
  readonly onComplete: (album: AlbumListing) => void;
}): ReactElement {
  const intl = useIntl();
  const [value, setValue] = useState(album.tags.join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    void window.overlook.albums
      .setTags({
        albumId: album.id,
        tags: value
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag) => tag !== ''),
      })
      .then(({ album: updated }) => onComplete(updated))
      .catch(() => {
        setSaving(false);
        setError(intl.formatMessage(messages.saveFailed));
      });
  };
  return (
    <Dialog
      open
      title={intl.formatMessage(messages.tagsTitle, { name: album.name })}
      icon={album.kind === 'folder' ? 'folder' : 'album'}
      {...(saving ? {} : { onClose })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {intl.formatMessage(messages.cancel)}
          </Button>
          <Button variant="primary" type="submit" form={`tags-${album.id}`} disabled={saving}>
            {intl.formatMessage(saving ? messages.saving : messages.save)}
          </Button>
        </>
      }
    >
      <form id={`tags-${album.id}`} onSubmit={submit}>
        <label className="ovl-album-dialog__label" htmlFor={`tags-${album.id}-input`}>
          {intl.formatMessage(messages.tagsLabel)}
        </label>
        <input
          id={`tags-${album.id}-input`}
          className="ovl-album-dialog__input"
          value={value}
          maxLength={600}
          autoFocus
          onChange={(event) => setValue(event.currentTarget.value)}
        />
        <p className="ovl-album-dialog__safe-copy">{intl.formatMessage(messages.tagsNote)}</p>
        <ErrorLine error={error} />
      </form>
    </Dialog>
  );
}
