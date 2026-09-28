import { useEffect, useId, useLayoutEffect, useRef, type ReactElement } from 'react';

import { Icon, type IconName } from './Icon';
import '../grid/context-menu.css';

export interface ContextMenuItem {
  readonly id: string;
  readonly label: string;
  /** Leading glyph. Radio items (see `checked`) draw their own check instead. */
  readonly icon?: IconName | undefined;
  readonly action: () => void;
  readonly detail?: string | undefined;
  /** Right-aligned accelerator hint (e.g. `?`); part of the item's name. */
  readonly hint?: string | undefined;
  readonly disabledReason?: string | undefined;
  readonly danger?: boolean | undefined;
  readonly separatorBefore?: boolean | undefined;
  /** Set on every item of a single-choice menu: the item becomes a
   *  `menuitemradio` and shows a check when true (#1291). */
  readonly checked?: boolean | undefined;
  /** A secondary line linked by `aria-describedby`, so it describes the item
   *  without becoming part of its name (#1291). */
  readonly description?: string | undefined;
}

export interface ContextMenuProps {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly items: readonly ContextMenuItem[];
  readonly onClose: () => void;
  readonly closeOnSelect?: boolean | undefined;
  /** Which item takes focus on open — `last` for keyboard opens via ↑/End,
   *  `checked` for a radio menu's current choice. */
  readonly initialFocus?: 'first' | 'last' | 'checked' | undefined;
  /** Tab closes the menu (focus goes wherever `onClose` puts it) instead of
   *  leaving it open behind the next control. */
  readonly closeOnTab?: boolean | undefined;
  /** Which menu edge sits at `x`: `left` (default) or `right`, for a menu
   *  anchored to a control's inline start in RTL. */
  readonly anchorEdge?: 'left' | 'right' | undefined;
}

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"]';

export function ContextMenu({
  label,
  x,
  y,
  items,
  onClose,
  closeOnSelect = true,
  initialFocus = 'first',
  closeOnTab = false,
  anchorEdge = 'left',
}: ContextMenuProps): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu === null) return;
    const left = anchorEdge === 'right' ? x - menu.offsetWidth : x;
    menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
    const menuItems = Array.from(menu.querySelectorAll<HTMLButtonElement>(ITEM_SELECTOR));
    const checked = initialFocus === 'checked' ? menuItems.find((item) => item.getAttribute('aria-checked') === 'true') : undefined;
    (checked ?? (initialFocus === 'last' ? menuItems.at(-1) : menuItems[0]))?.focus();
  }, [x, y, initialFocus, anchorEdge]);

  useEffect(() => {
    const close = (): void => onClose();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    // Menu focus belongs on its menuitems per the APG composite pattern.

    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      className="ovl-context-menu"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Esc closes this menu only: stopped here, before the document, so a
        // dialog the menu sits in stays open (#1299).
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key === 'Tab' && closeOnTab) {
          event.preventDefault();
          onClose();
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const menuItems = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(ITEM_SELECTOR));
        if (menuItems.length === 0) return;
        const current = menuItems.indexOf(document.activeElement as HTMLButtonElement);
        const target =
          event.key === 'Home'
            ? menuItems[0]
            : event.key === 'End'
              ? menuItems.at(-1)
              : event.key === 'ArrowDown'
                ? menuItems[(current + 1) % menuItems.length]
                : menuItems[current === -1 ? menuItems.length - 1 : (current - 1 + menuItems.length) % menuItems.length];
        target?.focus();
      }}
    >
      {items.map((item) => (
        <ContextMenuRow
          key={item.id}
          item={item}
          menuId={menuId}
          onSelect={() => {
            if (item.disabledReason !== undefined) return;
            if (closeOnSelect) onClose();
            item.action();
          }}
        />
      ))}
    </div>
  );
}

function ContextMenuRow({
  item,
  menuId,
  onSelect,
}: {
  readonly item: ContextMenuItem;
  readonly menuId: string;
  readonly onSelect: () => void;
}): ReactElement {
  const descriptionId = item.description === undefined ? undefined : `${menuId}-${item.id}-description`;
  const reasonId = item.disabledReason === undefined ? undefined : `${menuId}-${item.id}-reason`;
  const describedBy = [descriptionId, reasonId].filter((id) => id !== undefined).join(' ');
  return (
    <div className={item.separatorBefore === true ? 'ovl-context-menu__separated' : undefined}>
      <button
        type="button"
        role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
        aria-checked={item.checked}
        className={item.danger === true ? 'ovl-context-menu__danger' : undefined}
        aria-disabled={item.disabledReason === undefined ? undefined : true}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        title={item.disabledReason}
        onClick={onSelect}
      >
        {item.checked === undefined ? (
          item.icon === undefined ? null : (
            <Icon name={item.icon} size={14} />
          )
        ) : (
          <span className="ovl-context-menu__check" aria-hidden="true">
            {item.checked ? <Icon name="check" size={14} /> : null}
          </span>
        )}
        {item.detail === undefined && descriptionId === undefined ? (
          <span>{item.label}</span>
        ) : (
          <span className="ovl-context-menu__body">
            <span>{item.label}</span>
            {item.detail === undefined ? null : <span className="ovl-context-menu__meta">{item.detail}</span>}
            {descriptionId === undefined ? null : (
              // Hidden from the name, still read as the description.
              <span id={descriptionId} className="ovl-context-menu__meta ovl-context-menu__description" aria-hidden="true">
                {item.description}
              </span>
            )}
          </span>
        )}
        {item.hint === undefined ? null : <span className="ovl-context-menu__hint">{item.hint}</span>}
      </button>
      {reasonId === undefined ? null : (
        // Hidden, so the menu holds only menuitems; a description still reads it.
        <span id={reasonId} hidden>
          {item.disabledReason}
        </span>
      )}
    </div>
  );
}
