import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import './library-switcher.css';
import { useFormats } from '../i18n/use-formats.js';
import type { LibraryDescriptor } from '../../../shared/library/registry.js';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Checkbox } from '../components/Checkbox';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { MoveLibraryDialog } from './MoveLibraryDialog';
import { RenameLibraryDialog } from './RenameLibraryDialog';
import { destructiveActions } from '../../../shared/destructive-actions.js';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { EditLibraryDisplayNameDialog } from './EditLibraryDisplayNameDialog';

// Library Switcher (#386, ADR-0017): view, switch, create, and manage the
// registered libraries. Switching hands off to the main process (#385) which
// tears down, repoints, and reloads this window — the "switching" phase here
// is honest about that: it survives only until the reload wipes the renderer.

type Phase = 'list' | 'switching' | 'create' | 'confirm-remove' | 'display-name' | 'move' | 'rename';

interface Refusal {
  readonly kind:
    'provider-busy' | 'locked' | 'locked-elsewhere' | 'missing' | 'switch-in-progress' | 'not-a-library' | 'already-registered' | 'error';
  readonly host?: string | null;
}

const REFUSAL_COPY: Record<Refusal['kind'], { title: string; detail: string }> = {
  'provider-busy': {
    title: "Can't switch while a backup is running",
    detail: 'Finish or wait for the current backup or restore before switching libraries.',
  },
  locked: { title: 'Overlook is locked', detail: 'Unlock the current library before switching.' },
  'locked-elsewhere': { title: 'This library is open elsewhere', detail: 'Close it there first, then switch.' },
  missing: { title: "This library's folder is missing", detail: 'Reconnect the volume it lives on, then try again.' },
  'switch-in-progress': { title: 'A switch is already in progress', detail: 'Hold on — the current switch has to finish first.' },
  'not-a-library': { title: "That folder isn't an Overlook library", detail: 'Choose a folder that contains an Overlook library.db.' },
  'already-registered': { title: 'Already in the list', detail: 'That library is registered here already.' },
  error: { title: 'Something went wrong', detail: 'The operation could not be completed safely. Try again.' },
};

// New copy goes through the catalog (ADR-0020 §6); the switcher's legacy
// literals hold a shrinking budget and migrate opportunistically.
const moveMessages = defineMessages({
  select: { id: 'libswitch.move.select', defaultMessage: 'Select {name} to move' },
  moveOne: { id: 'libswitch.move.one', defaultMessage: 'Move {name}…' },
  moveSelected: { id: 'libswitch.move.selected', defaultMessage: 'Move {count} selected…' },
  renameOne: { id: 'libswitch.rename.one', defaultMessage: 'Rename folder of {name}…' },
  editDisplayName: { id: 'libswitch.displayName.one', defaultMessage: 'Edit display name of {name}…' },
  duplicateHint: { id: 'libswitch.displayName.duplicateHint', defaultMessage: 'Location: {location} · ID ending {id}' },
  folder: { id: 'libswitch.displayName.folder', defaultMessage: 'Library folder' },
  changed: { id: 'libswitch.displayName.changed', defaultMessage: 'Display name changed to {name}' },
});

function privacySafeLocationHint(libraryPath: string): string | null {
  const parts = libraryPath
    .replace(/[\\/]+$/u, '')
    .split(/[\\/]+/u)
    .filter(Boolean);
  return parts.at(-1) ?? null;
}

export interface LibrarySwitcherProps {
  readonly onClose: () => void;
  readonly onCurrentNameChange?: ((name: string) => void) | undefined;
  /** Open straight into the "New library…" form (File → New Library…, #689). */
  readonly startInCreate?: boolean;
  /** Locked surfaces expose switching without library management (#847). */
  readonly switchOnly?: boolean;
}

export function LibrarySwitcher({
  onClose,
  onCurrentNameChange,
  startInCreate = false,
  switchOnly = false,
}: LibrarySwitcherProps): ReactElement {
  const intl = useIntl();
  const { formatRelativeTime } = useFormats();
  const { announce } = useAnnouncer();
  const [libs, setLibs] = useState<readonly LibraryDescriptor[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  // "4h ago" stamps are relative to load time, not render time (purity).
  const [loadedAt, setLoadedAt] = useState(0);
  const [phase, setPhase] = useState<Phase>(startInCreate ? 'create' : 'list');
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [switchTarget, setSwitchTarget] = useState<LibraryDescriptor | null>(null);
  const [removeTarget, setRemoveTarget] = useState<LibraryDescriptor | null>(null);
  const [removing, setRemoving] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createPath, setCreatePath] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [moveTargets, setMoveTargets] = useState<readonly LibraryDescriptor[] | null>(null);
  const [renameTarget, setRenameTarget] = useState<LibraryDescriptor | null>(null);
  const [displayNameTarget, setDisplayNameTarget] = useState<LibraryDescriptor | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLUListElement>(null);

  const refresh = useCallback((): void => {
    void Promise.all([window.overlook.libraries.list(), window.overlook.libraries.current()])
      .then(([{ libraries }, { library }]) => {
        setLibs(libraries);
        setCurrentId(library.id);
        setLoadedAt(Date.now());
      })
      .catch(() => setRefusal({ kind: 'error' }));
  }, []);
  useEffect(refresh, [refresh]);

  const current = libs?.find((lib) => lib.open) ?? libs?.find((lib) => lib.id === currentId) ?? null;

  const switchTo = (lib: LibraryDescriptor): void => {
    setRefusal(null);
    // The designed refusals are visible in the list itself — refuse locally
    // before asking main, so the banner explains rather than round-trips.
    if (lib.missing) {
      setRefusal({ kind: 'missing' });
      return;
    }
    if (lib.lockedBy !== null) {
      setRefusal({ kind: 'locked-elsewhere', host: lib.lockedBy });
      return;
    }
    if (lib.open || lib.id === currentId) {
      onClose();
      return;
    }
    setSwitchTarget(lib);
    setPhase('switching');
    announce(`Switching to ${lib.name}`, 'polite', 'library-switch');
    window.overlook.libraries
      .open({ id: lib.id })
      .then((outcome) => {
        if (!outcome.ok) {
          setPhase('list');
          setSwitchTarget(null);
          setRefusal({ kind: outcome.reason, host: outcome.host });
        }
        // ok: the main process reloads this window into the new library —
        // nothing to do; the switching screen holds until then.
      })
      .catch(() => {
        // A successful switch DESTROYS this JS context mid-IPC (window
        // reload) — no callback ever runs. So a rejection that reaches us
        // is a real failure (entry removed under us, teardown threw):
        // return to a fresh list instead of wedging on the progress screen
        // (PR #450 review).
        setPhase('list');
        setSwitchTarget(null);
        setRefusal({ kind: 'error' });
        refresh();
      });
  };

  const submitCreate = (event: FormEvent): void => {
    event.preventDefault();
    const name = createName.trim();
    if (name === '' || creating) return;
    setCreating(true);
    setRefusal(null);
    window.overlook.libraries
      .create({ name, path: createPath })
      .then(({ library }) => {
        // Acceptance 1: create and LAND in it — hand off to the switch.
        setCreating(false);
        setCreateName('');
        setCreatePath(null);
        switchTo(library);
      })
      .catch(() => {
        setCreating(false);
        setRefusal({ kind: 'error' });
      });
  };

  const addExisting = (): void => {
    setRefusal(null);
    window.overlook.libraries
      .add({ path: null })
      .then((outcome) => {
        if (outcome.ok) {
          refresh();
          return;
        }
        if (outcome.reason !== 'cancelled') setRefusal({ kind: outcome.reason });
      })
      .catch(() => setRefusal({ kind: 'error' }));
  };

  const confirmRemove = (): void => {
    if (removeTarget === null || removing) return;
    setRemoving(true);
    window.overlook.libraries
      .remove({ id: removeTarget.id })
      .then(() => {
        setRemoving(false);
        setRemoveTarget(null);
        setPhase('list');
        refresh();
      })
      .catch(() => {
        setRemoving(false);
        setRefusal({ kind: 'error' });
        setPhase('list');
      });
  };

  // ↑/↓ move focus between rows from anywhere in the modal (roving focus
  // keeps Enter = native activate). Document-level because the Dialog panel
  // holds focus on open — a handler on our subtree would never hear it.
  const inList = phase === 'list';
  useEffect(() => {
    if (!inList) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.ovl-libswitch__rowbtn') ?? []);
      if (rows.length === 0) return;
      const at = rows.findIndex((row) => row === document.activeElement);
      const next = event.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at === -1 ? 0 : at - 1);
      rows[next]?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [inList]);

  // Esc backs out of layered phases before it closes the switcher.
  const close = (): void => {
    if (phase === 'switching') return;
    if (phase === 'confirm-remove' || phase === 'create' || phase === 'display-name') {
      setPhase('list');
      setRemoveTarget(null);
      setDisplayNameTarget(null);
      return;
    }
    onClose();
  };

  if (phase === 'rename' && renameTarget !== null) {
    return (
      <RenameLibraryDialog
        library={renameTarget}
        onClose={() => {
          setPhase('list');
          setRenameTarget(null);
          refresh();
        }}
      />
    );
  }

  if (phase === 'display-name' && displayNameTarget !== null) {
    return (
      <EditLibraryDisplayNameDialog
        library={displayNameTarget}
        onClose={() => {
          setPhase('list');
          setDisplayNameTarget(null);
        }}
        onSaved={(updated) => {
          setLibs((previous) => previous?.map((library) => (library.id === updated.id ? updated : library)) ?? [updated]);
          if (updated.open || updated.id === currentId) onCurrentNameChange?.(updated.name);
          announce(intl.formatMessage(moveMessages.changed, { name: updated.name }), 'polite', 'library-display-name');
          setPhase('list');
          setDisplayNameTarget(null);
        }}
      />
    );
  }

  if (phase === 'move' && moveTargets !== null) {
    return (
      <MoveLibraryDialog
        libraries={moveTargets}
        onClose={() => {
          setPhase('list');
          setMoveTargets(null);
          setSelected(new Set());
          refresh();
        }}
      />
    );
  }

  if (phase === 'switching') {
    return (
      <Dialog open title="Switching libraries" icon="refresh-cw" width={420}>
        <div className="ovl-libswitch__progress" data-testid="switch-progress" role="status">
          <Icon name="refresh-cw" size={28} color="var(--accent-iris)" />
          <div className="ovl-libswitch__progress-steps">
            <div className="ovl-libswitch__step">
              <Icon name="check" size={14} color="var(--accent-green)" />
              <span>Settling writes</span>
            </div>
            <div className="ovl-libswitch__step">
              <Icon name="check" size={14} color="var(--accent-green)" />
              <span>Closing {current?.name ?? 'current library'}</span>
            </div>
            <div className="ovl-libswitch__step ovl-libswitch__step--active">
              <span className="ovl-libswitch__spinner" aria-hidden="true" />
              <span>Opening {switchTarget?.name ?? 'library'}…</span>
            </div>
          </div>
          <div className="mono-data ovl-libswitch__progress-note">Encrypted teardown · keys never leave this device</div>
        </div>
      </Dialog>
    );
  }

  if (phase === 'confirm-remove' && removeTarget !== null) {
    return (
      <Dialog
        open
        title={`Remove “${removeTarget.name}” from this list?`}
        icon="images"
        width={440}
        {...(removing ? {} : { onClose: close })}
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={removing}>
              Cancel
            </Button>
            <Button onClick={confirmRemove} disabled={removing} data-testid="remove-confirm">
              {removing ? 'Removing…' : destructiveActions.removeLibraryFromList.label}
            </Button>
          </>
        }
      >
        <p className="ovl-libswitch__remove-copy">This only removes the library from Overlook’s list here.</p>
        <div className="ovl-libswitch__reassure">
          <Icon name="shield-check" size={16} color="var(--accent-green)" />
          <span>{destructiveActions.removeLibraryFromList.survival}</span>
        </div>
        <div className="mono-data ovl-libswitch__remove-path">{removeTarget.path}</div>
      </Dialog>
    );
  }

  if (phase === 'create') {
    const trimmed = createName.trim();
    return (
      <Dialog
        open
        title="New library"
        icon="plus"
        width={440}
        {...(creating ? {} : { onClose: close })}
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={creating}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="library-create"
              disabled={trimmed === '' || creating}
              data-testid="create-confirm"
            >
              {creating ? 'Creating…' : 'Create library'}
            </Button>
          </>
        }
      >
        <form id="library-create" onSubmit={submitCreate}>
          <label className="ovl-libswitch__label" htmlFor="library-create-name">
            Library name
          </label>
          <input
            id="library-create-name"
            className="ovl-libswitch__input"
            value={createName}
            maxLength={120}
            autoFocus
            data-testid="create-name"
            onChange={(event) => setCreateName(event.currentTarget.value)}
          />
          <div className="ovl-libswitch__label">Location</div>
          <div className="ovl-libswitch__location">
            <span className="mono-data ovl-libswitch__location-path">{createPath ?? 'App-managed location'}</span>
            <Button
              size="sm"
              disabled={creating}
              onClick={() => {
                void window.overlook.libraries.pickLocation().then(({ path }) => {
                  if (path !== null) setCreatePath(path);
                });
              }}
            >
              Choose…
            </Button>
          </div>
          {refusal === null ? null : (
            <div className="ovl-libswitch__error" role="alert">
              {REFUSAL_COPY[refusal.kind].detail}
            </div>
          )}
        </form>
      </Dialog>
    );
  }

  return (
    <Dialog open title="Libraries" icon="images" width={520} onClose={close}>
      <div data-testid="library-switcher">
        {refusal === null ? null : (
          <div className="ovl-libswitch__banner" role="alert" data-testid="switch-refusal">
            <Icon name="triangle-alert" size={16} color="var(--accent-amber)" />
            <div className="ovl-libswitch__banner-copy">
              <div className="ovl-libswitch__banner-title">{REFUSAL_COPY[refusal.kind].title}</div>
              <div className="ovl-libswitch__banner-detail">{REFUSAL_COPY[refusal.kind].detail}</div>
              {refusal.host == null ? null : <div className="mono-data ovl-libswitch__banner-host">Locked on {refusal.host}</div>}
            </div>
            <IconButton icon="x" label="Dismiss" size="sm" onClick={() => setRefusal(null)} />
          </div>
        )}
        <div className="ovl-libswitch__count mono-data">{libs === null ? 'Loading…' : `${String(libs.length)} registered`}</div>
        <ul className="ovl-libswitch__list" ref={listRef} data-testid="library-list">
          {(libs ?? []).map((lib) => {
            const blocked = lib.missing || lib.lockedBy !== null;
            const duplicateName =
              (libs ?? []).filter((candidate) => candidate.name.localeCompare(lib.name, undefined, { sensitivity: 'base' }) === 0).length >
              1;
            return (
              <li
                key={lib.id}
                className={['ovl-libswitch__row', lib.open ? 'ovl-libswitch__row--open' : '', blocked ? 'ovl-libswitch__row--blocked' : '']
                  .filter(Boolean)
                  .join(' ')}
              >
                <button
                  type="button"
                  className="ovl-libswitch__rowbtn"
                  aria-disabled={blocked}
                  data-testid={`library-row-${lib.name}`}
                  onClick={() => switchTo(lib)}
                >
                  <span className="ovl-libswitch__rowmain">
                    <span className="ovl-libswitch__name">
                      {lib.name}
                      {lib.open ? <Badge tone="cyan">Open now</Badge> : null}
                      {lib.missing ? <Badge tone="amber">Missing</Badge> : null}
                      {lib.lockedBy === null ? null : <Badge tone="amber" icon="lock">{`Open on ${lib.lockedBy}`}</Badge>}
                    </span>
                    <span className="mono-data ovl-libswitch__path">{lib.path}</span>
                    {duplicateName ? (
                      <span className="mono-data ovl-libswitch__duplicate-hint">
                        {intl.formatMessage(moveMessages.duplicateHint, {
                          location: privacySafeLocationHint(lib.path) ?? intl.formatMessage(moveMessages.folder),
                          id: lib.id.slice(-4),
                        })}
                      </span>
                    ) : null}
                    {lib.missing ? <span className="ovl-libswitch__hint">Reconnect the volume to open this library</span> : null}
                  </span>
                  <span className="mono-data ovl-libswitch__when">
                    {lib.lastOpenedAt === null ? 'Never opened' : formatRelativeTime(lib.lastOpenedAt, loadedAt)}
                  </span>
                </button>
                {switchOnly || blocked ? null : (
                  <Checkbox
                    checked={selected.has(lib.id)}
                    label={intl.formatMessage(moveMessages.select, { name: lib.name })}
                    onChange={(checked) => {
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (checked) next.add(lib.id);
                        else next.delete(lib.id);
                        return next;
                      });
                    }}
                  />
                )}
                {switchOnly || blocked ? null : (
                  <IconButton
                    icon="folder"
                    label={intl.formatMessage(moveMessages.renameOne, { name: lib.name })}
                    size="sm"
                    data-testid={`rename-library-${lib.name}`}
                    onClick={() => {
                      setRefusal(null);
                      setRenameTarget(lib);
                      setPhase('rename');
                    }}
                  />
                )}
                {switchOnly ? null : (
                  <IconButton
                    icon="pencil"
                    label={intl.formatMessage(moveMessages.editDisplayName, { name: lib.name })}
                    size="sm"
                    data-testid={`edit-display-name-${lib.id}`}
                    onClick={() => {
                      setRefusal(null);
                      setDisplayNameTarget(lib);
                      setPhase('display-name');
                    }}
                  />
                )}
                {switchOnly || blocked ? null : (
                  <IconButton
                    icon="hard-drive"
                    label={intl.formatMessage(moveMessages.moveOne, { name: lib.name })}
                    size="sm"
                    data-testid={`move-library-${lib.name}`}
                    onClick={() => {
                      setRefusal(null);
                      setMoveTargets([lib]);
                      setPhase('move');
                    }}
                  />
                )}
                {switchOnly || lib.open ? null : (
                  <IconButton
                    icon="trash-2"
                    label={`${destructiveActions.removeLibraryFromList.label}: ${lib.name}`}
                    size="sm"
                    onClick={() => {
                      setRefusal(null);
                      setRemoveTarget(lib);
                      setPhase('confirm-remove');
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
        <div className="ovl-libswitch__footer">
          {switchOnly ? null : (
            <>
              <Button
                variant="primary"
                icon="plus"
                data-testid="new-library"
                onClick={() => {
                  setRefusal(null);
                  setPhase('create');
                }}
              >
                New library…
              </Button>
              <Button icon="folder-open" onClick={addExisting} data-testid="add-existing">
                Add existing…
              </Button>
              {selected.size === 0 ? null : (
                <Button
                  icon="hard-drive"
                  data-testid="move-selected"
                  onClick={() => {
                    setRefusal(null);
                    setMoveTargets((libs ?? []).filter((lib) => selected.has(lib.id)));
                    setPhase('move');
                  }}
                >
                  {intl.formatMessage(moveMessages.moveSelected, { count: selected.size })}
                </Button>
              )}
            </>
          )}
          <span className="mono-data ovl-libswitch__keys">↑↓ select · ⏎ switch · esc close</span>
        </div>
      </div>
    </Dialog>
  );
}
