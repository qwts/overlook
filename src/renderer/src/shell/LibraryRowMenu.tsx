import type { ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { LibraryDescriptor } from '../../../shared/library/registry.js';
import { destructiveActions } from '../../../shared/destructive-actions.js';
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu';
import { libraryRowActions, type LibraryActionBlock } from './library-row-actions';

// A library row's actions (#1299, Pass D): one menu, opened from the row's ⋯,
// by right-click, or by Shift+F10 / the Menu key. Every action is always
// listed; one the row cannot take is disabled with the reason.

const messages = defineMessages({
  displayName: { id: 'libswitch.menu.displayName', defaultMessage: 'Edit display name…' },
  rename: { id: 'libswitch.menu.rename', defaultMessage: 'Rename folder…' },
  move: { id: 'libswitch.menu.move', defaultMessage: 'Move…' },
  open: { id: 'libswitch.reason.open', defaultMessage: 'This library is open. Switch to another library first.' },
  missing: { id: 'libswitch.reason.missing', defaultMessage: 'Reconnect the volume first.' },
  elsewhere: { id: 'libswitch.reason.elsewhere', defaultMessage: 'Close it on {host} first.' },
});

export interface LibraryRowMenuProps {
  readonly library: LibraryDescriptor;
  readonly currentId: string | null;
  /** The ⋯ button's name, so the menu and its button read the same. */
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly onClose: () => void;
  readonly onEditDisplayName: () => void;
  readonly onRename: () => void;
  readonly onMove: () => void;
  readonly onRemove: () => void;
}

export function LibraryRowMenu({
  library,
  currentId,
  label,
  x,
  y,
  onClose,
  onEditDisplayName,
  onRename,
  onMove,
  onRemove,
}: LibraryRowMenuProps): ReactElement {
  const intl = useIntl();
  const actions = libraryRowActions(library, currentId);
  const reason = (block: LibraryActionBlock | null): string | undefined => {
    if (block === null) return undefined;
    if (block.reason === 'elsewhere') return intl.formatMessage(messages.elsewhere, { host: block.host });
    return intl.formatMessage(messages[block.reason]);
  };
  const items: ContextMenuItem[] = [
    {
      id: 'library.displayName',
      label: intl.formatMessage(messages.displayName),
      icon: 'pencil',
      action: onEditDisplayName,
      disabledReason: reason(actions.displayName),
    },
    {
      id: 'library.rename',
      label: intl.formatMessage(messages.rename),
      icon: 'folder',
      action: onRename,
      disabledReason: reason(actions.rename),
    },
    {
      id: 'library.move',
      label: intl.formatMessage(messages.move),
      icon: 'hard-drive',
      action: onMove,
      disabledReason: reason(actions.move),
    },
    {
      id: 'library.remove',
      label: `${destructiveActions.removeLibraryFromList.label}…`,
      icon: 'trash-2',
      action: onRemove,
      disabledReason: reason(actions.remove),
      separatorBefore: true,
    },
  ];
  return <ContextMenu label={label} x={x} y={y} items={items} onClose={onClose} />;
}
