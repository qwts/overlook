import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { libraryDisplayNameSchema, type LibraryDescriptor } from '../../../shared/library/registry.js';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';

const messages = defineMessages({
  title: { id: 'libswitch.displayName.title', defaultMessage: 'Edit display name' },
  label: { id: 'libswitch.displayName.label', defaultMessage: 'Display name' },
  help: {
    id: 'libswitch.displayName.help',
    defaultMessage: 'Only the name shown in Overlook changes. The folder, library ID, keys, and backups stay unchanged.',
  },
  invalid: {
    id: 'libswitch.displayName.invalid',
    defaultMessage: 'Enter a name without path separators or control characters, up to 120 characters.',
  },
  failed: { id: 'libswitch.displayName.failed', defaultMessage: 'The display name could not be updated. Try again.' },
  cancel: { id: 'libswitch.displayName.cancel', defaultMessage: 'Cancel' },
  save: { id: 'libswitch.displayName.save', defaultMessage: 'Save' },
  saving: { id: 'libswitch.displayName.saving', defaultMessage: 'Saving…' },
  reset: { id: 'libswitch.displayName.reset', defaultMessage: 'Reset to folder name' },
  resetting: { id: 'libswitch.displayName.resetting', defaultMessage: 'Resetting…' },
});

export interface EditLibraryDisplayNameDialogProps {
  readonly library: LibraryDescriptor;
  readonly onClose: () => void;
  readonly onSaved: (library: LibraryDescriptor) => void;
}

export function EditLibraryDisplayNameDialog({ library, onClose, onSaved }: EditLibraryDisplayNameDialogProps): ReactElement {
  const intl = useIntl();
  const [draft, setDraft] = useState(library.name);
  const [submitting, setSubmitting] = useState<'save' | 'reset' | null>(null);
  const [error, setError] = useState<'invalid' | 'failed' | null>(null);
  const parsed = libraryDisplayNameSchema.safeParse(draft);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (submitting !== null) return;
    if (!parsed.success) {
      setError('invalid');
      return;
    }
    setSubmitting('save');
    setError(null);
    void window.overlook.libraries
      .setDisplayName({ id: library.id, name: parsed.data })
      .then(({ library: updated }) => onSaved(updated))
      .catch(() => {
        setSubmitting(null);
        setError('failed');
      });
  };

  const reset = (): void => {
    if (submitting !== null) return;
    setSubmitting('reset');
    setError(null);
    void window.overlook.libraries
      .resetDisplayName({ id: library.id })
      .then(({ library: updated }) => onSaved(updated))
      .catch(() => {
        setSubmitting(null);
        setError('failed');
      });
  };

  const errorMessage = error === null ? null : intl.formatMessage(error === 'invalid' ? messages.invalid : messages.failed);

  return (
    <Dialog
      open
      title={intl.formatMessage(messages.title)}
      icon="pencil"
      width={440}
      {...(submitting === null ? { onClose } : {})}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting !== null}>
            {intl.formatMessage(messages.cancel)}
          </Button>
          <Button variant="primary" type="submit" form="library-display-name" disabled={submitting !== null}>
            {intl.formatMessage(submitting === 'save' ? messages.saving : messages.save)}
          </Button>
        </>
      }
    >
      <form id="library-display-name" onSubmit={submit}>
        <label className="ovl-libswitch__label" htmlFor="library-display-name-input">
          {intl.formatMessage(messages.label)}
        </label>
        <input
          id="library-display-name-input"
          className="ovl-libswitch__input"
          value={draft}
          autoFocus
          aria-invalid={error !== null}
          aria-describedby="library-display-name-help library-display-name-error"
          data-testid="library-display-name-input"
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setError(null);
          }}
        />
        <p id="library-display-name-help" className="ovl-libswitch__display-help">
          {intl.formatMessage(messages.help)}
        </p>
        <Button size="sm" icon="folder" onClick={reset} disabled={submitting !== null} data-testid="library-display-name-reset">
          {intl.formatMessage(submitting === 'reset' ? messages.resetting : messages.reset)}
        </Button>
        <div id="library-display-name-error" className="ovl-libswitch__error" role={errorMessage === null ? undefined : 'alert'}>
          {errorMessage}
        </div>
      </form>
    </Dialog>
  );
}
