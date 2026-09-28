import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement, RefObject } from 'react';

import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu';
import { Icon, type IconName } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { Slider } from '../components/Slider';

// The toolbar controls that swap for a compact replacement as the row
// collapses (#1290, Pass B spec §02). Both forms stay mounted and share a
// `data-collapse-slot`; the row's `data-collapse` picks which one shows, so
// the collapse hook can measure every level without a render and hand focus
// from one form to the other.

interface ZoomControlProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (zoom: number) => void;
  /** Hidden outside Grid view but still laid out, so the row holds still. */
  readonly hidden: boolean;
  /** At level 1 and above the slider lives in the Zoom popover. */
  readonly collapsed: boolean;
}

function ZoomScale({
  label,
  value,
  min,
  max,
  onChange,
  width,
}: Omit<ZoomControlProps, 'hidden' | 'collapsed'> & { readonly width: number }): ReactElement {
  return (
    <>
      <Icon name="grid-3x3" size={13} color="var(--text-faint)" />
      <Slider label={label} value={value} min={min} max={max} width={width} onChange={onChange} />
      <Icon name="grid-2x2" size={15} color="var(--text-faint)" />
    </>
  );
}

export function ToolbarZoom({ hidden, collapsed, ...scale }: ZoomControlProps): ReactElement {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const visibility: CSSProperties = { visibility: hidden ? 'hidden' : 'visible' };

  // The popover's owner is the Zoom button, so it can't outlive the button's
  // level or view (adjusted during render, not in an effect); the collapse
  // hook moves focus to the slider.
  if (open && (!collapsed || hidden)) setOpen(false);

  const close = (): void => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <>
      <div className="ovl-toolbar__zoom" data-collapse-slot="zoom" data-collapse-variant="full" style={visibility}>
        <ZoomScale {...scale} width={110} />
      </div>
      <div className="ovl-toolbar__zoom-compact" data-collapse-slot="zoom" data-collapse-variant="compact" style={visibility}>
        <IconButton
          ref={buttonRef}
          icon="zoom-in"
          label={scale.label}
          className="ovl-toolbar__zoom-button"
          aria-haspopup="dialog"
          aria-expanded={open}
          // Keep this pointerdown from reaching the popover's outside-click
          // listener, so a second click toggles it shut cleanly.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            setOpen((wasOpen) => !wasOpen);
          }}
        />
        {open ? <ZoomPopover anchor={buttonRef} onClose={close} onDismiss={() => setOpen(false)} {...scale} /> : null}
      </div>
    </>
  );
}

// A non-modal popover: focus moves in on open, Esc returns it to the Zoom
// button, and an outside click or Tab away just closes it.
function ZoomPopover({
  anchor,
  onClose,
  onDismiss,
  ...scale
}: Omit<ZoomControlProps, 'hidden' | 'collapsed'> & {
  readonly anchor: RefObject<HTMLButtonElement>;
  readonly onClose: () => void;
  readonly onDismiss: () => void;
}): ReactElement {
  const popoverRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    const button = anchor.current;
    if (popover === null || button === null) return;
    const rect = button.getBoundingClientRect();
    // Hang from the button's inline-end corner, in either direction.
    const rtl = getComputedStyle(button).direction === 'rtl';
    const left = rtl ? rect.left : rect.right - popover.offsetWidth;
    popover.style.left = `${Math.max(8, Math.min(left, window.innerWidth - popover.offsetWidth - 8))}px`;
    popover.style.top = `${rect.bottom + 4}px`;
    popover.querySelector<HTMLInputElement>('input')?.focus();
  }, [anchor]);

  useEffect(() => {
    const popover = popoverRef.current;
    if (popover === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const onFocusOut = (event: FocusEvent): void => {
      if (!(event.relatedTarget instanceof Node && popover.contains(event.relatedTarget))) onDismiss();
    };
    document.addEventListener('pointerdown', onDismiss);
    popover.addEventListener('keydown', onKeyDown);
    popover.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('pointerdown', onDismiss);
      popover.removeEventListener('keydown', onKeyDown);
      popover.removeEventListener('focusout', onFocusOut);
    };
  }, [onClose, onDismiss]);

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={scale.label}
      className="ovl-toolbar__zoom-popover"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <ZoomScale {...scale} width={140} />
    </div>
  );
}

export interface ViewMenuOption<V extends string> {
  readonly value: V;
  readonly label: string;
  readonly icon: IconName;
}

interface ViewMenuProps<V extends string> {
  readonly value: V;
  readonly options: readonly ViewMenuOption<V>[];
  /** The menu's name, "View". */
  readonly menuLabel: string;
  /** The button's name, "View: {mode}". */
  readonly triggerLabel: string;
  readonly onChange: (value: V) => void;
}

interface OpenViewMenu {
  readonly x: number;
  readonly y: number;
  readonly anchorEdge: 'left' | 'right';
  readonly focus: 'checked' | 'last';
}

/** The view Segmented's level-4 replacement: a button showing the current
 *  view's glyph that opens a radio menu of the `view.mode.*` commands. */
export function ToolbarViewMenu<V extends string>({ value, options, menuLabel, triggerLabel, onChange }: ViewMenuProps<V>): ReactElement {
  const [menu, setMenu] = useState<OpenViewMenu | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const current = options.find((option) => option.value === value);

  const openMenu = (focus: OpenViewMenu['focus']): void => {
    const button = buttonRef.current;
    if (button === null) return;
    const rect = button.getBoundingClientRect();
    // Hang from the button's inline-end corner, in either direction.
    const rtl = getComputedStyle(button).direction === 'rtl';
    setMenu({ x: rtl ? rect.left : rect.right, y: rect.bottom + 4, anchorEdge: rtl ? 'left' : 'right', focus });
  };
  const closeMenu = (): void => {
    setMenu(null);
    buttonRef.current?.focus();
  };
  const items: ContextMenuItem[] = options.map((option) => ({
    id: option.value,
    label: option.label,
    checked: option.value === value,
    action: () => {
      onChange(option.value);
    },
  }));

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="ovl-toolbar__view-menu"
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => {
          if (menu === null) openMenu('checked');
          else closeMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            openMenu('checked');
          } else if (event.key === 'ArrowUp' || event.key === 'End') {
            event.preventDefault();
            openMenu('last');
          }
        }}
      >
        {current === undefined ? null : <Icon name={current.icon} size={14} />}
        <Icon name="chevrons-up-down" size={12} />
      </button>
      {menu === null ? null : (
        <ContextMenu
          label={menuLabel}
          x={menu.x}
          y={menu.y}
          anchorEdge={menu.anchorEdge}
          items={items}
          initialFocus={menu.focus}
          closeOnTab
          onClose={closeMenu}
        />
      )}
    </>
  );
}
