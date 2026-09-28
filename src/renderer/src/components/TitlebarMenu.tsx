import { useRef, useState, type ReactElement } from 'react';
import { useIntl } from 'react-intl';

import { appMenuModel, appMenuShortcut } from '../../../shared/commands/app-menu.js';
import { HELP_MENU_ITEMS } from '../../../shared/commands/help-menu.js';
import type { CommandMenuContext } from '../../../shared/commands/menu-contract.js';
import { commandById, type CommandId, type CommandPlatform } from '../../../shared/commands/registry.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { Icon, type IconName } from './Icon';
import './titlebar.css';

interface TitlebarMenuProps {
  readonly label: string;
  readonly icon: IconName;
  readonly className: string;
  readonly items: readonly ContextMenuItem[];
}

// components/core/TitlebarMenu — a Windows/Linux titlebar menu button (Help,
// #699; the ⋯ Overlook menu, #1293). A no-drag button left of the window
// controls that opens the shared APG `ContextMenu`. ↓/Enter/Space open on the
// first item, ↑/End on the last. Every dismissal returns focus to the button
// before a chosen command runs, so a dialog it opens hands focus back there.
export function TitlebarMenu({ label, icon, className, items }: TitlebarMenuProps): ReactElement {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ readonly x: number; readonly y: number; readonly focus: 'first' | 'last' } | null>(null);

  const open = (focus: 'first' | 'last'): void => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    // Anchor bottom-right of the button; ContextMenu clamps into the viewport,
    // which right-aligns it against the near window edge (bottom-left in RTL).
    setMenu({ x: rect.right, y: rect.bottom, focus });
  };
  const close = (): void => {
    setMenu(null);
    buttonRef.current?.focus();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`ovl-titlebar__button ovl-titlebar__menu ${className}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        // Keep the button's own pointerdown from reaching ContextMenu's
        // document close listener, so a second click toggles it shut cleanly.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => (menu === null ? open('first') : close())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            open('first');
          } else if (event.key === 'ArrowUp' || event.key === 'End') {
            event.preventDefault();
            open('last');
          }
        }}
      >
        <Icon name={icon} size={16} />
      </button>
      {menu === null ? null : (
        <ContextMenu label={label} x={menu.x} y={menu.y} items={items} initialFocus={menu.focus} closeOnTab onClose={close} />
      )}
    </>
  );
}

// The Help glyphs mirror the macOS Help menu's intent; labels/order/shortcuts
// come from the shared registry list, so only the icon mapping lives here.
const HELP_ICON_BY_COMMAND: Partial<Record<CommandId, IconName>> = {
  'help.shortcuts': 'keyboard',
  'help.activity': 'database',
  'app.settings.open.privacy': 'shield-check',
  'help.open': 'circle-help',
};

interface PlatformMenuProps {
  /** process.platform. Windows/Linux only — macOS keeps its native menus, so
   *  these render nothing there (ADR-0024 §5, I2). */
  readonly platform: string;
  /** Dispatches the selected registry command — the same id and handler the
   *  macOS menu item uses, so the two platforms stay in parity (I1). */
  readonly onCommand: (command: CommandId) => void;
}

/** The titlebar Help menu (#699), populated from HELP_MENU_ITEMS. */
export function TitlebarHelpMenu({ platform, onCommand }: PlatformMenuProps): ReactElement | null {
  const intl = useIntl();
  if (platform === 'darwin') return null;
  const items: ContextMenuItem[] = HELP_MENU_ITEMS.map((entry) => {
    const command = commandById(entry.command);
    return {
      id: entry.menuItemId ?? entry.command,
      label: intl.formatMessage(command.label),
      icon: HELP_ICON_BY_COMMAND[entry.command] ?? 'circle-help',
      hint: command.key === '?' ? '?' : undefined,
      action: () => onCommand(entry.command),
      separatorBefore: entry.separatorBefore,
    };
  });
  return (
    <TitlebarMenu
      label={intl.formatMessage({ id: 'titlebar.help', defaultMessage: 'Help' })}
      icon="circle-help"
      className="ovl-titlebar__help"
      items={items}
    />
  );
}

/** The titlebar ⋯ Overlook menu (#1293): the macOS File, Edit, View, and
 *  Overlook commands with no other visible surface on Windows/Linux, grouped
 *  under their menu names. Disabled items stay, focusable, with any reason
 *  read as their description. */
export function TitlebarAppMenu({
  platform,
  onCommand,
  context,
}: PlatformMenuProps & { readonly context: CommandMenuContext }): ReactElement | null {
  const intl = useIntl();
  if (platform === 'darwin') return null;
  const shortcutPlatform: CommandPlatform = platform === 'win32' ? 'win32' : 'linux';
  const items: ContextMenuItem[] = appMenuModel(context).flatMap((group) =>
    group.items.map((item) => {
      const command = commandById(item.command);
      return {
        id: item.command,
        label: intl.formatMessage(command.label),
        group: { id: group.id, label: intl.formatMessage(group.heading) },
        disabled: !item.enabled,
        description: item.disabledReason === undefined ? undefined : intl.formatMessage(item.disabledReason),
        shortcut: appMenuShortcut(item.command, shortcutPlatform),
        action: () => onCommand(item.command),
      };
    }),
  );
  return (
    <TitlebarMenu
      label={intl.formatMessage({ id: 'titlebar.appMenu', defaultMessage: 'Overlook menu' })}
      icon="ellipsis"
      className="ovl-titlebar__app-menu"
      items={items}
    />
  );
}
