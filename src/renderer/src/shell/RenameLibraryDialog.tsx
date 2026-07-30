import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { FormattedMessage, defineMessages, useIntl } from 'react-intl';

import './library-switcher.css';
import './move-library.css';
import type { LibraryDescriptor } from '../../../shared/library/registry.js';
import { objectToFolderName } from '../../../shared/library/folder-name.js';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';

// Rename library folder (#686, ADR-0022): the final path component changes in
// Finder/Explorer through the journaled relocation engine — parent fixed,
// identity/keys/backup links untouched, display alias (#685) untouched. The
// name validates conservatively for every platform the disk might visit, and
// live inline objections keep the submit honest. Renaming the OPEN library
// quiesces, renames, and reopens — its success reloads this window, so a
// missing response on the open library is that reload racing us.

const objectionMessages = defineMessages({
  empty: { id: 'librename.objection.empty', defaultMessage: 'Enter a folder name.' },
  'dot-name': { id: 'librename.objection.dotName', defaultMessage: '“.” and “..” are not folder names.' },
  separator: { id: 'librename.objection.separator', defaultMessage: 'Folder names cannot contain / or \\.' },
  'forbidden-character': {
    id: 'librename.objection.forbiddenCharacter',
    defaultMessage: 'Some platforms refuse < > : " | ? * and control characters in folder names.',
  },
  'reserved-name': {
    id: 'librename.objection.reservedName',
    defaultMessage: 'Windows reserves this name (CON, PRN, AUX, NUL, COM1–9, LPT1–9).',
  },
  'leading-space': { id: 'librename.objection.leadingSpace', defaultMessage: 'Folder names cannot start with a space.' },
  'trailing-dot-or-space': {
    id: 'librename.objection.trailingDotOrSpace',
    defaultMessage: 'Folder names cannot end with a dot or a space.',
  },
  'too-long': { id: 'librename.objection.tooLong', defaultMessage: 'This name is too long for some filesystems.' },
});

// The engine's designed refusals, rendered as decided copy (ADR-0022 §5) —
// the rename-relevant subset of the move vocabulary plus the same-name case.
const reasonMessages = defineMessages({
  'destination-not-empty': {
    id: 'librename.reason.destinationNotEmpty',
    defaultMessage: 'A folder with this name already exists here — Overlook never overwrites or merges.',
  },
  'destination-registered': {
    id: 'librename.reason.destinationRegistered',
    defaultMessage: 'A registered library already uses this name here.',
  },
  'invalid-destination': { id: 'librename.reason.invalidDestination', defaultMessage: 'That name is not usable for this folder.' },
  'destination-not-writable': { id: 'librename.reason.destinationNotWritable', defaultMessage: 'This location is not writable.' },
  locked: { id: 'librename.reason.locked', defaultMessage: 'The library is open in another Overlook instance.' },
  'move-in-progress': { id: 'librename.reason.moveInProgress', defaultMessage: 'Another move is already running.' },
  'app-locked': { id: 'librename.reason.appLocked', defaultMessage: 'Unlock Overlook before renaming the open library.' },
  'provider-busy': { id: 'librename.reason.providerBusy', defaultMessage: 'Finish or wait for the current backup or restore first.' },
  cancelled: { id: 'librename.reason.cancelled', defaultMessage: 'Cancelled — the folder was not renamed.' },
  fallback: { id: 'librename.reason.fallback', defaultMessage: 'The rename could not be completed — the library is untouched.' },
});

const messages = defineMessages({
  title: { id: 'librename.title', defaultMessage: 'Rename library folder' },
  nameLabel: { id: 'librename.nameLabel', defaultMessage: 'Folder name' },
  cancel: { id: 'librename.cancel', defaultMessage: 'Cancel' },
  rename: { id: 'librename.rename', defaultMessage: 'Rename folder' },
  renaming: { id: 'librename.renaming', defaultMessage: 'Renaming…' },
  done: { id: 'librename.done', defaultMessage: 'Done' },
  renamed: { id: 'librename.renamed', defaultMessage: 'The folder now appears with its new name in Finder or Explorer.' },
  assurance: {
    id: 'librename.assurance',
    defaultMessage: 'Only the folder name changes. The library ID, keys, albums, backups, and display name stay exactly as they are.',
  },
  openNote: {
    id: 'librename.openNote',
    defaultMessage: 'This library is open now: Overlook closes it, renames the folder, and reopens it.',
  },
  pathArrow: { id: 'librename.pathArrow', defaultMessage: '{from} → {to}' },
  didNotReport: { id: 'librename.didNotReport', defaultMessage: 'The rename did not report back.' },
});

function currentFolderName(lib: LibraryDescriptor): string {
  return lib.path.split(/[\\/]/u).filter(Boolean).pop() ?? lib.name;
}

function renamedPath(lib: LibraryDescriptor, newName: string): string {
  return lib.path.replace(/[^\\/]+[\\/]?$/u, newName);
}

type Outcome = Awaited<ReturnType<typeof window.overlook.libraries.renameFolder>>;

export interface RenameLibraryDialogProps {
  readonly library: LibraryDescriptor;
  readonly onClose: () => void;
}

export function RenameLibraryDialog({ library, onClose }: RenameLibraryDialogProps): ReactElement {
  const intl = useIntl();
  const [name, setName] = useState(currentFolderName(library));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | 'no-response' | null>(null);
  const [renamedTo, setRenamedTo] = useState<string | null>(null);

  // The open library's successful rename reloads this window before the
  // response can land; treat silence as that reload racing us, not success.
  useEffect(() => {
    if (outcome !== 'no-response' || !library.open) return;
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close exactly once when the race resolves
  }, [outcome]);

  const objection = objectToFolderName(name);
  const unchanged = name === currentFolderName(library);

  const submit = (): void => {
    if (busy || objection !== null || unchanged) return;
    setBusy(true);
    setOutcome(null);
    const destPath = renamedPath(library, name);
    void window.overlook.libraries
      .renameFolder({ id: library.id, newName: name })
      .then((result) => {
        setOutcome(result);
        if (result.ok) setRenamedTo(destPath);
      })
      .catch(() => setOutcome('no-response'))
      .finally(() => setBusy(false));
  };

  const failed = outcome !== null && outcome !== 'no-response' && !outcome.ok ? outcome : null;
  const succeeded = outcome !== null && outcome !== 'no-response' && outcome.ok;

  if (succeeded) {
    return (
      <Dialog
        open
        title={intl.formatMessage(messages.title)}
        icon="pencil"
        width={480}
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose} data-testid="rename-done">
            <FormattedMessage {...messages.done} />
          </Button>
        }
      >
        <div className="ovl-libmove__reassure" data-testid="rename-success">
          <Icon name="circle-check" size={16} color="var(--accent-green)" />
          <span>
            <FormattedMessage {...messages.renamed} />
          </span>
        </div>
        <div className="mono-data ovl-libmove__path">
          <FormattedMessage {...messages.pathArrow} values={{ from: library.path, to: renamedTo ?? renamedPath(library, name) }} />
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      title={intl.formatMessage(messages.title)}
      icon="pencil"
      width={480}
      {...(busy ? {} : { onClose })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            <FormattedMessage {...messages.cancel} />
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="library-rename"
            disabled={busy || objection !== null || unchanged}
            data-testid="rename-confirm"
          >
            {busy ? <FormattedMessage {...messages.renaming} /> : <FormattedMessage {...messages.rename} />}
          </Button>
        </>
      }
    >
      <form
        id="library-rename"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="mono-data ovl-libmove__path">{library.path}</div>
        <label className="ovl-libswitch__label" htmlFor="library-rename-name">
          <FormattedMessage {...messages.nameLabel} />
        </label>
        <input
          id="library-rename-name"
          className="ovl-libswitch__input"
          value={name}
          maxLength={255}
          autoFocus
          disabled={busy}
          data-testid="rename-name"
          {...(objection === null ? {} : { 'aria-invalid': true, 'aria-describedby': 'library-rename-objection' })}
          onChange={(event) => {
            setName(event.currentTarget.value);
            setOutcome(null);
          }}
        />
        {objection === null || name === '' ? null : (
          <div className="ovl-libmove__error" id="library-rename-objection" role="alert" data-testid="rename-objection">
            <FormattedMessage {...objectionMessages[objection]} />
          </div>
        )}
        {objection === null && !unchanged ? (
          <div className="mono-data ovl-libmove__dest-preview" data-testid="rename-preview">
            <FormattedMessage {...messages.pathArrow} values={{ from: currentFolderName(library), to: name }} />
          </div>
        ) : null}
        {failed === null ? null : (
          <div className="ovl-libmove__error" role="alert" data-testid="rename-refusal">
            <FormattedMessage
              {...(failed.reason in reasonMessages
                ? reasonMessages[failed.reason as keyof typeof reasonMessages]
                : reasonMessages.fallback)}
            />
            {failed.detail === '' ? null : <span className="mono-data ovl-libmove__error-detail"> {failed.detail}</span>}
          </div>
        )}
        {outcome === 'no-response' && !library.open ? (
          <div className="ovl-libmove__error" role="alert">
            <FormattedMessage {...messages.didNotReport} />
          </div>
        ) : null}
        <div className="ovl-libmove__reassure">
          <Icon name="shield-check" size={16} color="var(--accent-green)" />
          <span>
            <FormattedMessage {...messages.assurance} />
          </span>
        </div>
        {library.open ? (
          <div className="ovl-libmove__note">
            <Icon name="refresh-cw" size={14} color="var(--accent-iris)" />
            <span>
              <FormattedMessage {...messages.openNote} />
            </span>
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
