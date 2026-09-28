import { useRef, useState } from 'react';
import type { ReactElement, Ref } from 'react';

import './forms.css';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { Icon } from './Icon';

export interface SearchFieldModeOption<M extends string> {
  readonly value: M;
  readonly label: string;
  /** Read as the item's description, not its name. */
  readonly description: string;
}

/** A single-choice mode menu at the field's inline start (#1291). The caller
 *  owns every string, so the field stays free of search-domain copy. */
export interface SearchFieldMode<M extends string> {
  readonly value: M;
  readonly options: readonly SearchFieldModeOption<M>[];
  /** The menu's name, e.g. "Search mode". */
  readonly menuLabel: string;
  /** The button's name, naming the current mode, e.g. "Search mode: Auto". */
  readonly triggerLabel: string;
  /** Show the current mode's name on the button (off for the default mode). */
  readonly showName: boolean;
}

export interface SearchFieldProps<M extends string = string> {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  /** Mono shortcut hint, hidden while focused (and while text is present). */
  readonly shortcut?: string;
  /** Fixed width in px, or `auto` to let the container size it (the toolbar
   *  flexes it between its min and max, #1290). */
  readonly width?: number | 'auto';
  /** Durable accessible name — the placeholder is not one. */
  readonly label?: string;
  readonly mode?: SearchFieldMode<M> | undefined;
  /** Called only when an item is chosen; Esc, Tab, and outside clicks change nothing. */
  readonly onModeChange?: ((mode: M) => void) | undefined;
}

interface OpenMenu {
  readonly x: number;
  readonly y: number;
  readonly anchorEdge: 'left' | 'right';
  readonly focus: 'checked' | 'last';
  /** Where a dismissal returns focus: the control the menu was opened from. */
  readonly from: 'trigger' | 'input';
}

// The mode menu's state and focus rules (#1291): a choice returns focus to the
// input; every other dismissal returns it to whichever control opened the
// menu, so focus never drops to <body>.
function useModeMenu<M extends string>(mode: SearchFieldMode<M> | undefined, onModeChange: ((mode: M) => void) | undefined) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const openMenu = (focusItem: OpenMenu['focus'], from: OpenMenu['from']): void => {
    const trigger = triggerRef.current;
    if (trigger === null) return;
    const rect = trigger.getBoundingClientRect();
    // Hang from the button's inline-start corner, in either direction.
    const rtl = getComputedStyle(trigger).direction === 'rtl';
    setMenu({ x: rtl ? rect.right : rect.left, y: rect.bottom + 4, anchorEdge: rtl ? 'right' : 'left', focus: focusItem, from });
  };
  const closeMenu = (): void => {
    const from = menu?.from ?? 'trigger';
    setMenu(null);
    (from === 'input' ? inputRef.current : triggerRef.current)?.focus();
  };
  const items: ContextMenuItem[] =
    mode === undefined
      ? []
      : mode.options.map((option) => ({
          id: option.value,
          label: option.label,
          description: option.description,
          checked: option.value === mode.value,
          action: () => {
            onModeChange?.(option.value);
            inputRef.current?.focus();
          },
        }));
  return { menu, triggerRef, inputRef, openMenu, closeMenu, items };
}

// components/forms/SearchField.jsx + the clear affordance from #60's scope:
// an × appears when there is text, clears it, and returns focus to the input.
export function SearchField<M extends string = string>({
  value,
  onChange,
  placeholder = 'Search photos, places, cameras…',
  shortcut = '',
  width = 280,
  label = 'Search',
  mode,
  onModeChange,
}: SearchFieldProps<M>): ReactElement {
  const [focus, setFocus] = useState(false);
  const { menu, triggerRef, inputRef, openMenu, closeMenu, items } = useModeMenu(mode, onModeChange);

  return (
    <div className="ovl-search" style={width === 'auto' ? undefined : { width }}>
      {mode === undefined ? (
        <Icon name="search" size={14} />
      ) : (
        <>
          <SearchModeButton
            buttonRef={triggerRef}
            mode={mode}
            expanded={menu !== null}
            onToggle={() => {
              if (menu === null) openMenu('checked', 'trigger');
              else closeMenu();
            }}
            onOpen={(focusItem) => {
              openMenu(focusItem, 'trigger');
            }}
          />
          <span className="ovl-search__divider" aria-hidden="true" />
        </>
      )}
      <input
        ref={inputRef}
        className="ovl-search__input"
        type="text"
        role="searchbox"
        aria-label={label}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (mode !== undefined && event.altKey && event.key === 'ArrowDown') {
            event.preventDefault();
            openMenu('checked', 'input');
          }
        }}
        onFocus={() => {
          setFocus(true);
        }}
        onBlur={() => {
          setFocus(false);
        }}
        placeholder={placeholder}
      />
      <SearchTrailing value={value} shortcut={shortcut} focused={focus} onClear={() => onChange('')} />
      {menu === null || mode === undefined ? null : (
        <ContextMenu
          label={mode.menuLabel}
          x={menu.x}
          y={menu.y}
          anchorEdge={menu.anchorEdge}
          items={items}
          initialFocus={menu.focus}
          closeOnTab
          onClose={closeMenu}
        />
      )}
    </div>
  );
}

// The field's inline-start mode trigger: search glyph, the mode's name when
// it is not the default, and a chevron. Enter/Space/click toggle via onToggle;
// ↓ opens on the checked item, ↑/End on the last.
function SearchModeButton<M extends string>({
  buttonRef,
  mode,
  expanded,
  onToggle,
  onOpen,
}: {
  // Not `ref`: React 18 strips that from function-component props.
  readonly buttonRef: Ref<HTMLButtonElement>;
  readonly mode: SearchFieldMode<M>;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpen: (focusItem: OpenMenu['focus']) => void;
}): ReactElement {
  const current = mode.options.find((option) => option.value === mode.value);
  return (
    <button
      ref={buttonRef}
      type="button"
      className="ovl-search__mode"
      aria-label={mode.triggerLabel}
      aria-haspopup="menu"
      aria-expanded={expanded}
      // Keep this pointerdown from reaching the menu's outside-click
      // listener, so a second click toggles it shut cleanly.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          onOpen('checked');
        } else if (event.key === 'ArrowUp' || event.key === 'End') {
          event.preventDefault();
          onOpen('last');
        }
      }}
    >
      <Icon name="search" size={14} />
      {mode.showName && current !== undefined ? <span className="ovl-search__mode-name">{current.label}</span> : null}
      <Icon name="chevrons-up-down" size={12} />
    </button>
  );
}

// Trailing slot: the × clear button while there is text, else the shortcut
// hint (hidden while focused).
function SearchTrailing({
  value,
  shortcut,
  focused,
  onClear,
}: {
  readonly value: string;
  readonly shortcut: string;
  readonly focused: boolean;
  readonly onClear: () => void;
}): ReactElement | null {
  return value.length > 0 ? (
    <button
      type="button"
      aria-label="Clear search"
      className="ovl-search__clear"
      onMouseDown={(event) => {
        // Keep focus in the field across the click.
        event.preventDefault();
      }}
      onClick={() => {
        onClear();
      }}
    >
      <Icon name="x" size={12} />
    </button>
  ) : shortcut !== '' && !focused ? (
    <span className="ovl-search__hint">{shortcut}</span>
  ) : null;
}
