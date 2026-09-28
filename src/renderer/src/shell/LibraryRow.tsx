import type { ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { LibraryDescriptor } from '../../../shared/library/registry.js';
import { Badge } from '../components/Badge';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import '../components/inputs.css';

// One library in the switcher (#1299, Pass D). In the list the row switches
// and a ⋯ beside it opens the row's actions; in selection mode the row itself
// is the checkbox and the ⋯ is gone. Nothing interactive sits inside the row.

const messages = defineMessages({
  open: { id: 'libswitch.row.open', defaultMessage: 'Open now' },
  missing: { id: 'libswitch.row.missing', defaultMessage: 'Missing' },
  openOn: { id: 'libswitch.row.openOn', defaultMessage: 'Open on {host}' },
  reconnect: { id: 'libswitch.row.reconnect', defaultMessage: 'Reconnect the volume to open this library' },
});

export interface LibraryRowProps {
  readonly library: LibraryDescriptor;
  readonly when: string;
  /** Location and ID shown when another library has the same name. */
  readonly duplicateHint: string | null;
  /** The ⋯ button's name; null hides it (switch-only view, selection mode). */
  readonly actionsLabel: string | null;
  readonly menuOpen: boolean;
  /** Selection mode: whether this row is checked, and whether it can be. */
  readonly selection: { readonly checked: boolean; readonly blocked: boolean } | null;
  readonly onActivate: () => void;
  /** Opens the actions menu under `anchor`, or at a pointer position. */
  readonly onOpenActions: (anchor: HTMLElement, origin: HTMLElement, at?: { x: number; y: number }) => void;
}

// In Move several the tint means checked only; the Open now badge still
// marks the open row.
function rowClass(open: boolean, selection: LibraryRowProps['selection'], blocked: boolean): string {
  return [
    'ovl-libswitch__row',
    open && selection === null ? 'ovl-libswitch__row--open' : '',
    selection?.checked === true ? 'ovl-libswitch__row--checked' : '',
    blocked ? 'ovl-libswitch__row--blocked' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function LibraryRow({
  library,
  when,
  duplicateHint,
  actionsLabel,
  menuOpen,
  selection,
  onActivate,
  onOpenActions,
}: LibraryRowProps): ReactElement {
  const intl = useIntl();
  const blocked = library.missing || library.lockedBy !== null;
  const manage = actionsLabel !== null;
  return (
    <li data-library-id={library.id} className={rowClass(library.open, selection, blocked)}>
      <button
        type="button"
        className="ovl-libswitch__rowbtn"
        {...(selection === null
          ? { 'aria-disabled': blocked }
          : { role: 'checkbox', 'aria-checked': selection.checked, 'aria-disabled': selection.blocked })}
        data-testid={`library-row-${library.name}`}
        onClick={onActivate}
        onContextMenu={
          manage
            ? (event) => {
                event.preventDefault();
                onOpenActions(event.currentTarget, event.currentTarget, { x: event.clientX, y: event.clientY });
              }
            : undefined
        }
        onKeyDown={
          manage
            ? (event) => {
                if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                event.preventDefault();
                const actions = event.currentTarget.parentElement?.querySelector<HTMLElement>('.ovl-libswitch__actions');
                onOpenActions(actions ?? event.currentTarget, event.currentTarget);
              }
            : undefined
        }
      >
        {selection === null ? null : (
          // The Checkbox glyph, drawn only: the row itself is the checkbox.
          <span className={`ovl-checkbox__box${selection.checked ? ' ovl-checkbox__box--on' : ''}`} aria-hidden="true">
            {selection.checked ? <Icon name="check" size={11} strokeWidth={3} /> : null}
          </span>
        )}
        <span className="ovl-libswitch__rowmain">
          <span className="ovl-libswitch__name">
            {library.name}
            {library.open ? <Badge tone="cyan">{intl.formatMessage(messages.open)}</Badge> : null}
            {library.missing ? <Badge tone="amber">{intl.formatMessage(messages.missing)}</Badge> : null}
            {library.lockedBy === null ? null : (
              <Badge tone="amber" icon="lock">
                {intl.formatMessage(messages.openOn, { host: library.lockedBy })}
              </Badge>
            )}
          </span>
          <span className="mono-data ovl-libswitch__path">{library.path}</span>
          {duplicateHint === null ? null : <span className="prose-note ovl-libswitch__duplicate-hint">{duplicateHint}</span>}
          {library.missing ? <span className="ovl-libswitch__hint">{intl.formatMessage(messages.reconnect)}</span> : null}
        </span>
        <span className="prose-note ovl-libswitch__when">{when}</span>
      </button>
      {actionsLabel === null ? null : (
        <IconButton
          icon="ellipsis"
          label={actionsLabel}
          className="ovl-libswitch__actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-testid={`library-actions-${library.id}`}
          onClick={(event) => onOpenActions(event.currentTarget, event.currentTarget)}
        />
      )}
    </li>
  );
}
